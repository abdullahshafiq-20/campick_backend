import { GoogleGenerativeAI } from '@google/generative-ai';
import pool from '../config/database.js';
import dotenv from 'dotenv';

dotenv.config();

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY_3);

const schema = `
    users(id, user_name, email, password, imageURL, is_verified, role, auth_type, alert_count)
    warnings(warning_id, user_id, warning_type, warning_message, created_at)
    shops(id, owner_id, name, description, image_url, total_revenue)
    shop_contacts(id, shop_id, email, contact_number, full_name, account_title, payment_method, payment_details, is_primary)
    menu_items(item_id, shop_id, name, description, image_url, price)
    orders(order_id, user_id, shop_id, total_price, status, payment_status)
    order_items(id, order_id, item_id, quantity, price)
    payments(payment_id, order_id, user_id, shop_id, amount, payment_method, payment_screenshot_url, gemini_response, verification_status)
    otps(id, otp, user_id, created_at, expires_at, is_used)
`;

const cleanSqlQuery = (sqlQuery) => {
    // Remove code block markers, leading/trailing whitespace
    let cleanedQuery = sqlQuery.replace(/```(sql)?/g, '').trim();
    
    // Remove any comments
    cleanedQuery = cleanedQuery.replace(/--.*$/gm, '');
    
    // Validate and remove potentially dangerous keywords
    const dangerousKeywords = ['DROP', 'DELETE', 'TRUNCATE', 'ALTER', 'GRANT', 'CREATE', 'INSERT', 'UPDATE'];
    dangerousKeywords.forEach(keyword => {
        const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
        if (regex.test(cleanedQuery)) {
            throw new Error(`Unsafe SQL operation detected: ${keyword}`);
        }
    });
    
    // Additional basic sanitization
    cleanedQuery = cleanedQuery.replace(/;+$/, ''); // Remove trailing semicolons
    
    return cleanedQuery;
}

export const nlQueryController = {
    // Improved method to clean and parse SQL query

    processNaturalLanguageQuery: async (req, res) => {
        try {
            // Get query from body, query params, or URL params
            const query = req.body?.query || req.query?.query || req.params?.query?.replace(/_/g, ' ');
            console.log('Received query:', query);
            console.log('Database Schema:', schema);

            if (!query) {
                return res.status(400).json({
                    success: false,
                    message: 'Natural language query is required'
                });
            }

            // Step 1: Convert natural language to SQL
            const sqlPrompt = `Convert the following natural language query to a SQL query for a MySQL database.
            The Database Schema is: ${schema}
            Only return the text based SQL query without any explanation or code block markers.
            Natural language query: "${query}"`;

            const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-lite" });
            const sqlResult = await model.generateContent(sqlPrompt);
            
            // Clean the SQL query
            const sqlQuery = cleanSqlQuery(sqlResult.response.text());
            console.log('Cleaned SQL Query:', sqlQuery);

            // Step 2: Execute the SQL query
            const queryResult = await pool.query(sqlQuery);
            console.log('Query Result:', queryResult);

            // Check if queryResult is an array and extract the first element as rows
            const rows = Array.isArray(queryResult) && queryResult.length > 0 ? queryResult[0] : []; // Default to an empty array if undefined

            // Step 3: Generate natural language response with table explanation
            const explanationPrompt = `Given this SQL query: "${sqlQuery}"
            and this data: ${JSON.stringify(rows)}
            and the original question: "${query}"
            Please provide a natural language response that:
            1. Explains how many results were found
            2. Summarizes key information about the orders (total count, total value, date range)
            3. Mentions any patterns in the data (like same shop_id or total_price)
            Keep the response clear and concise.`;

            const explanationResult = await model.generateContent(explanationPrompt);
            const naturalResponse = explanationResult.response.text();

            // Step 4: Format table data
            const tableData = rows.length > 0 ? {
                columns: Object.keys(rows[0]),
                rows: rows
            } : { columns: [], rows: [] };

            res.status(200).json({
                success: true,
                data: {
                    naturalLanguageQuery: query,
                    sqlQuery: sqlQuery,
                    naturalResponse: naturalResponse,
                    tableData: tableData
                }
            });

        } catch (error) {
            console.error('Error processing natural language query:', error);
            res.status(500).json({
                success: false,
                message: 'Error processing natural language query',
                error: error.message
            });
        }
    },

};