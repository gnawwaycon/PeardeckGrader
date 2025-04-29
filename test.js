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
        width: 1920,
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
        console.log("Connecting to database...");
        await client.connect();
        console.log("Database connected.");

        let page_num = 1; // Assuming pagination starts at 1
        while (true) {
            console.log(`Processing page ${page_num}...`);

            // Wait for essential elements on the current page/view
            try {
                 // Wait for the container that holds the question parts AND the student name
                 await page.waitForSelector('[data-cy="studentName"]', { timeout: 30000 }); // Student name
                 await page.waitForSelector('.QuestionWrapperStyledComponents__QuestionContainer-sc-1u752ip-3', { timeout: 30000 }); // Question part container
                 console.log(`Elements found on page ${page_num}.`);
            } catch (waitError) {
                 console.warn(`Essential elements not found on page ${page_num}. Might be the end or an error.`, waitError.message);
                 // Potentially save screenshot before breaking
                 // await page.screenshot({ path: `debug_page_${page_num}_wait_error.png`, fullPage: true });
                 break; // Exit loop if elements aren't found
            }

            const studentData = await page.evaluate(() => {
                // Selectors based on the provided HTML and logic refinement
                const studentNameSelector = '[data-cy="studentName"]';
                // This selector targets the container for a single question part (e.g., 1a or 1b)
                const partContainerSelector = '.QuestionWrapperStyledComponents__QuestionContainer-sc-1u752ip-3[data-cy="question-container"]';
                // Selector for the part label (a, b) relative to its partContainer
                const partLabelSelector = '.QuestionSubLabel__SubLabel-sc-c362p1-0';
                // Selector for the code text container relative to its partContainer
                const codeContainerSelector = '.EssayRichTextPreview__EssayRichTextContainer-sc-tzjrn-0';
                // Selector for the paragraphs containing code, relative to the codeContainer
                const pTagSelector = '.MathFormulaDisplay-sc-16rkkq2-0 p';

                const nameElements = Array.from(document.querySelectorAll(studentNameSelector));
                const partContainers = Array.from(document.querySelectorAll(partContainerSelector));

                const results = []; // Store { studentName: '...', combinedCode: '...' }

                if (nameElements.length === 0) {
                    console.warn("No student names found on this page.");
                    return results;
                }
                 if (partContainers.length === 0) {
                    console.warn("No question part containers found on this page.");
                     // Might still process names if that's useful, but likely indicates an issue.
                     return results;
                }

                // **Crucial Assumption:** Parts per student is constant on the page and elements are ordered Student1(PartA, PartB), Student2(PartA, PartB)...
                const partsPerStudent = partContainers.length / nameElements.length;

                if (partsPerStudent !== Math.floor(partsPerStudent) || partsPerStudent < 1) {
                    console.error(`Error: Inconsistent number of parts per student. Found ${nameElements.length} students and ${partContainers.length} parts. Parts per student calculates to ${partsPerStudent}. Skipping page.`);
                    // You might want to throw an error or handle this differently
                    return []; // Return empty results for this page
                }
                 console.log(`Detected ${nameElements.length} students and ${partContainers.length} parts (${partsPerStudent} parts per student).`);

                nameElements.forEach((nameElement, studentIndex) => {
                    // Extract name, handle potential variations in spacing/structure
                    let studentName = "Unknown Student";
                    try {
                       // The split by non-breaking space might be fragile. Test carefully.
                       const nameText = nameElement?.innerText || '';
                       const nameParts = nameText.split('\u00A0'); // Non-breaking space
                       studentName = (nameParts[1] || nameText).trim(); // Use second part or full text if split fails
                    } catch (nameError) {
                       console.warn(`Could not reliably extract name for element at index ${studentIndex}. Element text: ${nameElement?.innerText}`);
                    }

                    let combinedCode = '';
                    console.log(`Processing student (${studentIndex + 1}/${nameElements.length}): ${studentName}`);

                    for (let partIndexOffset = 0; partIndexOffset < partsPerStudent; partIndexOffset++) {
                        const overallPartIndex = studentIndex * partsPerStudent + partIndexOffset;
                        const partContainer = partContainers[overallPartIndex];

                        if (!partContainer) {
                            console.warn(`  - Warning: Could not find part container expected at index ${overallPartIndex} for student ${studentName}. Skipping this part.`);
                            combinedCode += `[Part container missing for index ${overallPartIndex}]\n\n`;
                            continue; // Skip this part
                        }

                        // Find part label within this part's container
                        const partLabelElement = partContainer.querySelector(partLabelSelector);
                        const partLabel = partLabelElement ? partLabelElement.innerText.trim() : `Part ${partIndexOffset + 1}`; // Fallback label

                        // Find code container within this part's container
                        const codeContainer = partContainer.querySelector(codeContainerSelector);
                        let currentPartCode = '';

                        if (codeContainer) {
                            // Find all relevant <p> tags within the code container
                            const pTags = codeContainer.querySelectorAll(pTagSelector);
                            pTags.forEach(pTag => {
                                // Append text content directly, preserving original spacing/newlines within the tag
                                currentPartCode += pTag.textContent + '\n';
                            });
                            currentPartCode = currentPartCode.trimEnd(); // Remove trailing newline only
                        } else {
                            console.warn(`  - Warning: Code container (.EssayRichTextPreview...) not found for ${partLabel} of student ${studentName}.`);
                            currentPartCode = "[Code container not found]";
                        }

                         console.log(`  - Found ${partLabel}. Code length: ${currentPartCode.length}`);
                        // Combine with label and separator
                        combinedCode += `${partLabel}\n---------------------\n${currentPartCode}\n\n`;
                    } // End loop through parts for one student

                    results.push({
                       studentName: studentName,
                       combinedCode: combinedCode.trim() // Trim final result for the student
                    });
                    console.log(`  - Finished combining parts for ${studentName}. Total length: ${combinedCode.trim().length}`);

                }); // End loop through students

                return results;
            }); // End page.evaluate

            console.log(`Scraped data for ${studentData.length} students on page ${page_num}.`);

            // Insert data into the database
            if (studentData.length > 0) {
                console.log("Inserting data into database...");
                const insertQuery = `
                    INSERT INTO ${process.env.TABLE_NAME} (student_name, code, question)
                    VALUES ($1, $2, $3)
                    ON CONFLICT (student_name, question) DO UPDATE SET code = EXCLUDED.code; -- Optional: Update if student/question combo exists
                    `;
                // Use a loop for sequential inserts (safer) or Promise.all for parallel (faster)
                for (const data of studentData) {
                    try {
                        const questionIdentifier = process.env.QUESTION || 'Unknown Question'; // Use env variable or a default
                        await client.query(insertQuery, [data.studentName, data.combinedCode, questionIdentifier]);
                    } catch (dbError) {
                        console.error(`Database insert error for student ${data.studentName}:`, dbError);
                        // Decide if you want to continue or stop on error
                    }
                }
                console.log("Finished inserting data for this page.");
            } else {
                 console.log("No student data returned from page evaluation.");
                 // This might happen on the last page after pagination, or if an error occurred in evaluate.
                 // Check the console logs from page.evaluate above.
            }


            // --- Pagination ---
            console.log(`Checking for next page (page ${page_num + 1})...`);
            const nextButtonSelector = `.ant-pagination-item-${page_num + 1} a`; // Selector for the link inside the page number button
            const nextButton = await page.$(nextButtonSelector);

            if (nextButton) {
                console.log(`Next page button found. Attempting to navigate to page ${page_num + 1}.`);

                // 1. Get the name of the first student currently visible
                const firstStudentNameSelector = '[data-cy="studentName"]';
                let oldFirstName = null;
                try {
                     // Ensure the element exists before getting text
                     await page.waitForSelector(firstStudentNameSelector, { timeout: 5000 });
                     oldFirstName = await page.$eval(firstStudentNameSelector, el => el.innerText);
                     console.log(`Current first student name: ${oldFirstName}`);
                } catch(e) {
                    console.warn("Could not get current first student name before clicking next. Proceeding with click anyway.");
                }

                // 2. Click the next button
                await nextButton.click();
                console.log("Clicked next button.");

                // 3. Wait for the content to update instead of navigation
                try {
                    console.log("Waiting for page content to update (e.g., first student name change)...");
                    const waitTimeout = 60000; // Timeout for waiting for the update

                    if (oldFirstName) {
                        // Option A: Wait for the first student name to be DIFFERENT
                         await page.waitForFunction(
                            (selector, expectedOldName) => {
                                const currentFirstStudent = document.querySelector(selector);
                                // Check if element exists and its text is different from the old one
                                return currentFirstStudent && currentFirstStudent.innerText !== expectedOldName;
                            },
                            { timeout: waitTimeout }, // Apply timeout
                            firstStudentNameSelector, // Pass selector to the function
                            oldFirstName             // Pass the old name to the function
                        );
                         console.log("First student name changed, assuming page updated.");
                    } else {
                         // Option B: If old name wasn't captured, wait for *any* student name element
                         // to appear again after a brief delay (less reliable).
                         console.log("Old name not captured, waiting for student name selector to re-appear after click...");
                         await new Promise(resolve => setTimeout(resolve, 1000)); // Short delay
                         await page.waitForSelector(firstStudentNameSelector, { timeout: waitTimeout });
                         console.log("Student name selector found after click, assuming page updated.");
                    }

                     // Add an additional small delay for stability after content update detection
                     await new Promise(resolve => setTimeout(resolve, 2000));
                     console.log("Proceeding to scrape page", page_num + 1);


                } catch (error) {
                    console.error(`Error waiting for page ${page_num + 1} content to update:`, error);
                     // Save screenshot for debugging pagination failures
                     try {
                         await page.screenshot({ path: `error_page_${page_num + 1}_update_timeout.png`, fullPage: true });
                         console.log(`Saved error_page_${page_num + 1}_update_timeout.png`);
                     } catch (ssError) {
                         console.error("Could not save error screenshot:", ssError);
                     }
                     // Decide whether to break or try to continue
                     console.log("Breaking pagination loop due to update timeout.");
                     break; // Exit the loop if page update fails
                }

                page_num++;
                // The small delay here is now less critical but doesn't hurt
                // await new Promise(resolve => setTimeout(resolve, 1500));

            } else {
                console.log("No next page button found. Assuming end of pagination.");
                break; // No more pages
            }
        } // End while loop (pagination)
    } catch (err) {
        console.error("An error occurred during scraping:", err);
        // Save screenshot for debugging errors
        try {
           await page.screenshot({ path: 'error_screenshot.png', fullPage: true });
           console.log("Saved error_screenshot.png for debugging.");
        } catch (ssError) {
           console.error("Could not save error screenshot:", ssError);
        }
    } finally {
        if (client) {
            try {
                await client.end();
                console.log("Database connection closed.");
            } catch (dbCloseError) {
                console.error("Error closing database connection:", dbCloseError);
            }
        }
        if (browser) {
            await browser.close();
            console.log("Browser closed.");
        }
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