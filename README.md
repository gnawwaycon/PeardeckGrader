set up database
create table student_submissions
(
    id              serial
        primary key,
    student_name    text not null,
    code            text not null,
    llm_response    text,
    submission_time timestamp with time zone default CURRENT_TIMESTAMP,
    question        text
);

get peardeck user info and add gemini api to set up .env

EMAIL=
PASSWORD=
GEMAPI=
DB_USER=
DB_HOST=
DB_NAME=
DB_PASSWORD=

TABLE_NAME="student_submissions"
DATAURL=
QUESTION = 

change dataurl to submissions page
change question to question name

open test.js and run 
getCodePeardeck();

then run
processSubmissionsWithLLM();
