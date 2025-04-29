import puppeteer from "puppeteer";
import pg from "pg";
import 'dotenv/config';
import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMAPI);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });

// Database connection details (from environment variables)
const dbConfig = {
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT || 5432, // Default PostgreSQL port
};

// Function to process code with Gemini 
async function processCodeWithGemini(code, question) {
    try {
        const prompt = `
        Grade out of  points **I ONLY want the feedback followed by a Dollar Sign then the score**
    	like this format: The code completes the prompt but has a few syntax errors $ 9

        Scoring Notes:

    Focus on Core Concepts: This rubric prioritizes understanding interfaces, implementation, method overriding, and basic class structure.
    Minor Syntax Errors: Small typos or syntax errors that don't fundamentally break the concept (e.g., missing semicolon if easily inferred) should ideally not prevent points from being awarded, especially at the "attempt" or "basic structure" levels.
    Unnecessary Code: The presence of default constructors or unused instance variables in Bell should not result in point deductions, as the prompt explicitly mentioned they weren't required (but didn't forbid them).
    Generosity: The goal is leniency. Award points if the student demonstrates understanding of the key requirement for that point, even if execution isn't perfect. A student making a good attempt should easily score 4 points (e.g., correct interface structure + correct class declaration + implements + attempt at method). Getting the details exactly right earns the final points.
	
There is no Penalty for:
- Extraneous code with no side‐effect (e.g., valid precondition check, no‐op)
- Spelling/case discrepancies for variables and identifiers
- Local variable not declared provided other variables are declared in some part
- private or public qualifier on a local variable
- Missing public qualifier on class or constructor header
- Keyword used as an identifier
- Common mathematical symbols used for operators (× • ÷ ≤ ≥ <> ≠)
- [] vs. () vs. <>
- = instead of == and vice versa
- length/size confusion for array, String, List, or ArrayList; with or without ( )
- Extraneous [] when referencing entire array
- [i,j] instead of [i][j]
- Extraneous size in array declaration, e.g., int[size] nums = new int[size];
- Missing ; where structure clearly conveys intent
- Missing { } where indentation clearly conveys intent
- Missing ( ) on parameter‐less method or constructor invocations
- Missing ( ) around if or while conditions
        ` + " \n and their code was" + code;
        const result = await model.generateContent(prompt);
        const response = result.response;
        const text = response.text();
        console.log("LLM Response:", text);
        return text;


    } catch (error) {
        console.error("Error processing code with Gemini:", error);
        return null; // Or handle the error as appropriate for your application
    }
}

async function getCodePeardeck() {
    const browser = await puppeteer.launch({
        headless: true,
        defaultViewport: null,
    });

    const page = await browser.newPage();

    await page.goto('https://app.edulastic.com/login', {
        waitUntil: ["domcontentloaded"],
    });

    await page.waitForSelector('#email');

    // Enter user and password
    await page.type('#email', process.env.EMAIL);
    await page.type('#password', process.env.PASSWORD);
    await page.click('[class^="ant-btn Container__LoginButton"]');

    await page.waitForNavigation();

    await page.goto('https://app.edulastic.com/author/assignments');

    
    const URL = process.env.DATAURL;
    await page.goto(URL);

    // Wait for all elements to be visible
    await page.waitForFunction(() => {
        const placeholders = document.querySelectorAll('.renderIfVisible-placeholder');
        return Array.from(placeholders).every(placeholder => placeholder.style.display === 'none');
    });

    await page.setViewport({
        width: 19200,
        height: 10800
    });


    // Scroll through the page to ensure all elements are rendered
    await page.evaluate(async () => {
        const distance = 100; // Distance to scroll
        const delay = 100; // Delay between scrolls
        const scrollHeight = document.body.scrollHeight;
        let totalHeight = 0;
        while (totalHeight < scrollHeight) {
            window.scrollBy(0, distance);
            totalHeight += distance;
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    });

 
    const client = new pg.Client(dbConfig);
    try {
        await client.connect();

        let page_num = 1;
        while (true) {
            await page.waitForSelector('[class^="MathFormulaDisplay"]');
            await page.waitForSelector('[data-cy="studentName"]'); // Wait for student names

            const [codeSnippets, studentNames] = await page.evaluate(() => {
                const divSelector = '[class^="EssayRichTextPreview__EssayRichTextContainer"]';
                const nameSelector = '[data-cy="studentName"]';
                const divs = Array.from(document.querySelectorAll(divSelector));
                const nameElements = Array.from(document.querySelectorAll(nameSelector));
                const codeArray = [];
                const nameArray = [];

                console.log(`Found ${divs.length} code containers and ${nameElements.length} student names on the page.`);

                divs.forEach((div, index) => {
                    const nameElement = nameElements[index];
                    const pTags = div.querySelectorAll('p');
                    let divCode = '';
                    pTags.forEach(pTag => {
                        const codeText = pTag.textContent.trim();
                        divCode += codeText + '\n';
                    });

                    console.log(`Processing student: ${nameElement.innerText.split('\u00A0')[1]}`);

                    codeArray.push(divCode.trim());
                    nameArray.push(nameElement.innerText.split('\u00A0')[1]);
                });

                return [codeArray, nameArray];
            });

            for (let i = 0; i < codeSnippets.length; i++) {
                const code = codeSnippets[i];
                const studentName = studentNames[i];
                const question = process.env.QUESTION;
                // Insert into the database
                const insertQuery = `
          INSERT INTO ${process.env.TABLE_NAME} (student_name, code, question)
          VALUES ($1, $2, $3)
        `;
                await client.query(insertQuery, [studentName, code, question]);
            }

            // Pagination
            const nextButton = await page.$(`.ant-pagination-item-${page_num + 1} a`);
            if (nextButton) {
                await nextButton.click();
                page_num++;
            } else {
                break; // No more pages
            }
        }
    } catch (err) {
        console.error("An error occurred:", err);
    } finally {
        await client.end();
        console.log("Database connection closed.");
        // await browser.close();
    }
}

async function processSubmissionsWithLLM() {
    const client = new pg.Client(dbConfig);
    try {
        await client.connect();

        // Fetch submissions that haven't been processed
        const selectQuery = `SELECT id, student_name, code, question FROM ${process.env.TABLE_NAME} WHERE llm_response IS NULL`;
        const result = await client.query(selectQuery);

        // Calculate delay between requests (in milliseconds)
        const requestsPerMinute = 10;
        const delayMs = 60 * 1000 / requestsPerMinute; // 60 seconds * 1000 ms / requests per minute

        for (let i = 0; i < result.rows.length; i++) {
            const row = result.rows[i];
            const { id, student_name, code, question } = row;

            
            if (question==process.env.QUESTION) {
                console.log(`Processing submission ${id} for ${student_name}...`);

                // Call the LLM function
                const llmResponse = await processCodeWithGemini(code, question);

                // Update the database with the LLM response
                const updateQuery = `UPDATE ${process.env.TABLE_NAME} SET llm_response = $1 WHERE id = $2`;
                await client.query(updateQuery, [llmResponse, id]);

                //Delay before the next request if it's not the last request
                if (i < result.rows.length - 1) {
                    console.log(`Waiting for ${delayMs}ms before the next request...`);
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                }
            }
        }


        console.log("Finished processing submissions.");
    } catch (err) {
        console.error("Error processing submissions with LLM:", err);
    } finally {
        await client.end();
    }
}

// Example usage:
getCodePeardeck();
// processSubmissionsWithLLM();