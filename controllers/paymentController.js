import Tesseract from 'tesseract.js';
import { v4 as uuidv4 } from 'uuid';
import pool from '../config/database.js';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from "@google/generative-ai";
import { getApiKey } from '../utils/apiKeyRotation.js';
import {io } from '../app.js';
import nodemailer from 'nodemailer';
import { generateOrderConfirmationEmail } from '../utils/emailTemplate.js';
import { incrementAlertCount } from '../utils/orderUtils.js';
dotenv.config();



// gemini 1.5 pro usage
export const verifyPaymentAndCreateOrder = async (req, res) => {
    const { payment_screenshot_url, shop_id, amount, payment_method, items } = req.body;
    const user_id = req.user.id;
    const user_role = req.user.role;
    const order_id = uuidv4();
    const payment_id = uuidv4();
    

    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        // 1. Validate input
        if (!payment_screenshot_url || !shop_id || !amount || !payment_method || !items || !items.length) {
            throw new Error('Missing required fields');
        }

        // Check user's alert_count if they are a student
        if (user_role === 'student') {
            const [userResult] = await connection.execute(
                'SELECT alert_count FROM users WHERE id = ?',
                [user_id]
            );

            if (userResult[0].alert_count >= 3) {
                await connection.rollback();
                return res.status(403).json({ 
                    status: 'error',
                    error: 'Order creation blocked', 
                    message: 'You have accumulated too many alerts. Please contact administration.'
                });
            }
        }

        // Calculate total price and prepare item details
        let total_price = 0;
        const itemDetails = [];

        // Verify items and calculate total price
        for (const item of items) {
            const [menuItemResult] = await connection.execute(
                'SELECT price, name FROM menu_items WHERE item_id = ? AND shop_id = ?',
                [item.item_id, shop_id]
            );

            if (menuItemResult.length === 0) {
                throw new Error(`Menu item ${item.item_id} not found or does not belong to the shop`);
            }

            const unit_price = menuItemResult[0].price;
            const item_total_price = unit_price * item.quantity;
            total_price += item_total_price;

            itemDetails.push({
                item_id: item.item_id,
                name: menuItemResult[0].name,
                quantity: item.quantity,
                unit_price: unit_price,
                total_price: item_total_price
            });
        }

        // 2. Create order
        await connection.execute(
            `INSERT INTO orders (
                order_id, user_id, shop_id, 
                total_price, status, payment_status
            ) VALUES (?, ?, ?, ?, ?, ?)`,
            [order_id, user_id, shop_id, total_price, 'pending', 'pending']
        );

        // Insert order items
        for (const item of itemDetails) {
            await connection.execute(
                'INSERT INTO order_items (order_id, item_id, quantity, price) VALUES (?, ?, ?, ?)',
                [order_id, item.item_id, item.quantity, item.total_price]
            );
        }

        // 3. Create payment record
        await connection.execute(
            `INSERT INTO payments (
                payment_id, order_id, user_id, shop_id, 
                amount, payment_method, payment_screenshot_url, 
                verification_status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [payment_id, order_id, user_id, shop_id, amount, payment_method, 
             payment_screenshot_url, 'pending']
        );

        // Verify the order items insertion
        const [verifyOrderItems] = await connection.execute(`
            SELECT oi.*, mi.name as item_name
            FROM order_items oi
            JOIN menu_items mi ON oi.item_id = mi.item_id
            WHERE oi.order_id = ?
        `, [order_id]);

        console.log('Verified order items:', verifyOrderItems);

        // After verifying order items, get user's email
        const [userEmail] = await connection.execute(
            'SELECT email FROM users WHERE id = ?',
            [user_id]
        );

        // 4. Use Gemini API to analyze the payment screenshot
        let geminiResult;
        try {
            geminiResult = await analyzePaymentScreenshot(payment_screenshot_url);
            console.log(geminiResult, "geminiResult");
            
            // Parse the Gemini result
            let parsedGeminiResult;
            if (typeof geminiResult === 'string') {
                // Remove any markdown formatting if present
                const cleanedResult = geminiResult.replace(/```json\n|\n```/g, '').trim();
                parsedGeminiResult = JSON.parse(cleanedResult);
            } else if (typeof geminiResult === 'object') {
                parsedGeminiResult = geminiResult;
            } else {
                throw new Error('Unexpected Gemini API response format');
            }
            
            // Update payment record with Gemini analysis
            await connection.execute(
                'UPDATE payments SET gemini_response = ? WHERE payment_id = ?',
                [JSON.stringify(parsedGeminiResult), payment_id]
            );

            // 5. Verify payment amount from Gemini analysis
            if (!verifyPaymentAmount(parsedGeminiResult.totalAmount, amount)) {
                throw new Error('Payment amount verification failed');
            }

            // 6. Update order and payment status
            await connection.execute(
                'UPDATE orders SET status = ?, payment_status = ? WHERE order_id = ?',
                ['pending', 'pending', order_id]
            );

            await connection.execute(
                'UPDATE payments SET verification_status = ? WHERE payment_id = ?',
                ['pending', payment_id]
            );

            // ... (rest of the function remains the same)

            await connection.commit();
            


            // Set up email transporter
            const transporter = nodemailer.createTransport({
                host: 'smtp.gmail.com',
                port: 587,
                secure: false,
                auth: {
                    user: process.env.EMAIL_USER,
                    pass: process.env.EMAIL_PASS
                },
                tls: {
                    rejectUnauthorized: false
                }
            });

            // Get shop name for the email
            const [shopDetails] = await connection.execute(
                'SELECT name FROM shops WHERE id = ?',
                [shop_id]
            );

            // Prepare order details for email
            const orderDetails = {
                order_id,
                total_price: amount,
                items: verifyOrderItems,
                shop_name: shopDetails[0].name,
                payment_method,
                payment_status: 'pending',
                order_status: 'pending'
            };

            // Send confirmation email
            try {
                await transporter.sendMail({
                    from: process.env.EMAIL_USER,
                    to: userEmail[0].email,
                    subject: 'Order Confirmation - Campick NUCES',
                    html: generateOrderConfirmationEmail(orderDetails)
                });
                console.log('Order confirmation email sent successfully');
            } catch (emailError) {
                console.error('Error sending order confirmation email:', emailError);
                // Don't throw error here, just log it - the order is still valid
            }

            // After successful payment verification and before sending response
            io.emit('paymentUpdate', {
                type: 'verification',
                orderId: order_id,
                paymentId: payment_id,
                status: 'verified',
                shopId: shop_id,
                userId: user_id,
                amount: amount,
                timestamp: new Date()
            });

            // Get order details for socket emission
            const [orderForSocket] = await connection.execute(`
                SELECT 
                    o.*,
                    u.user_name as customer_name,
                    s.name as shop_name,
                    p.payment_method,
                    p.verification_status
                FROM orders o
                JOIN users u ON o.user_id = u.id
                JOIN shops s ON o.shop_id = s.id
                JOIN payments p ON o.order_id = p.order_id
                WHERE o.order_id = ?
            `, [order_id]);

            const [orderItemsForSocket] = await connection.execute(`
                SELECT 
                    oi.*,
                    mi.name as item_name,
                    mi.image_url
                FROM order_items oi
                JOIN menu_items mi ON oi.item_id = mi.item_id
                WHERE oi.order_id = ?
            `, [order_id]);

            // Emit socket event for new order
            io.emit('newOrder', {
                ...orderForSocket[0],
                items: orderItemsForSocket,
                type: 'new_order',
                timestamp: new Date()
            });

            // Emit to shop-specific channel
            io.emit(`shop_order_${shop_id}`, {
                type: 'new_order',
                order: {
                    ...orderForSocket[0],
                    items: orderItemsForSocket
                },
                timestamp: new Date()
            });

            res.status(201).json({
                status: 'success',
                message: 'Payment verified and order created successfully',
                order: {
                    order_id,
                    user_id,
                    shop_id,
                    amount,
                    payment_method,
                    items: verifyOrderItems,
                    gemini_analysis: parsedGeminiResult
                }
            });

        } catch (geminiError) {
            console.error('Gemini API Error:', geminiError);
            await connection.rollback();
            throw new Error('Failed to process payment screenshot: ' + geminiError.message);
        }

    } catch (error) {
        await connection.rollback();
        console.error('Payment verification error:', error);
        res.status(500).json({
            status: 'error',
            message: error.message || 'Failed to verify payment and create order'
        });
    } finally {
        connection.release();
    }
};

// Helper function to analyze payment screenshot using Gemini API
const analyzePaymentScreenshot = async (imageUrl) => {
    try {
        // Set up the API key
        const apiKey = getApiKey();
        const genAI = new GoogleGenerativeAI(apiKey);

        // Set up the model
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-lite" });

        // Fetch the image data from the URL
        const response = await fetch(imageUrl);
        if (!response.ok) {
            throw new Error(`Failed to fetch image: ${response.statusText}`);
        }
        const imageBuffer = await response.arrayBuffer();

        // Convert the image buffer to base64
        const base64Image = Buffer.from(imageBuffer).toString('base64');

        const image = {
            inlineData: {
                data: base64Image,
                mimeType: "image/jpeg"  // Adjust this if the image might be in a different format
            }
        };

        const prompt = `Analyze this payment screenshot and extract the following information:
        1. Bank name
        2. Total amount paid
        3. Sender's name or account (From)
        4. Recipient's name or account (To)

        Provide the information in a JSON format with keys: bankName, totalAmount, from, to.
        
        Example format:
        {
            "bankName": "Example Bank",
            "totalAmount": "1000.00",
            "from": "John Doe",
            "to": "Jane Smith"
        }`;

        const result = await model.generateContent([prompt, image]);
        return result.response.text();

    } catch (error) {
        console.error('Gemini API processing failed:', error);
        throw new Error('Gemini API processing failed: ' + error.message);
    }
};

export default analyzePaymentScreenshot;



// Helper function to verify payment amount
const verifyPaymentAmount = (extractedAmount, expectedAmount) => {
    // Remove commas and convert to float
    const cleanedExtractedAmount = parseFloat(extractedAmount.replace(/,/g, ''));
    const cleanedExpectedAmount = parseFloat(expectedAmount);

    // Allow for a small difference (e.g., 1%) to account for potential inaccuracies
    const tolerance = cleanedExpectedAmount * 0.01;
    return Math.abs(cleanedExtractedAmount - cleanedExpectedAmount) <= tolerance;
};

// API endpoint to fetch shop payment details
export const getShopPaymentDetails = async (req, res) => {
    const { shopId } = req.params;

    try {
        const [paymentDetails] = await pool.execute(
            `SELECT sc.*, u.email as owner_email
             FROM shop_contacts sc
             JOIN shops s ON sc.shop_id = s.id
             JOIN users u ON s.owner_id = u.id
             WHERE sc.shop_id = ?`,
            [shopId]
        );

        if (!paymentDetails.length) {
            return res.status(404).json({
                status: 'error',
                message: 'Shop payment details not found'
            });
        }

        // Format payment details for frontend
        const formattedDetails = paymentDetails.map(detail => ({
            id: detail.id,
            type: detail.payment_method,
            details: [
                detail.full_name,
                detail.payment_details,
                detail.contact_number
            ].filter(Boolean)
        }));

        res.json({
            status: 'success',
            methods: formattedDetails
        });

    } catch (error) {
        console.error('Error fetching shop payment details:', error);
        res.status(500).json({
            status: 'error',
            message: 'Failed to fetch shop payment details'
        });
    }
};

export const getPaymentDetails = async (req, res) => {
    try {
        const query = `
            SELECT 
                u.user_name as customer_name,
                u.role,
                o.order_id,
                o.total_price,
                p.payment_method,
                p.payment_screenshot_url,
                p.gemini_response,
                p.verification_status,
                o.status as order_status,
                o.created_at as order_date
            FROM 
                payments p
                INNER JOIN orders o ON p.order_id = o.order_id
                INNER JOIN users u ON p.user_id = u.id
            WHERE 
                p.payment_id = ?
        `;

        const [paymentDetail] = await pool.execute(query, [req.params.paymentId]);

        if (!paymentDetail || paymentDetail.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Payment details not found'
            });
        }

        // Format the response
        const formattedResponse = {
            success: true,
            data: {
                customerName: paymentDetail[0].customer_name,
                role: paymentDetail[0].role,
                order: {
                    orderId: paymentDetail[0].order_id,
                    status: paymentDetail[0].order_status,
                    orderDate: paymentDetail[0].order_date,
                    totalPrice: paymentDetail[0].total_price
                },
                payment: {
                    method: paymentDetail[0].payment_method,
                    screenshotUrl: paymentDetail[0].payment_screenshot_url,
                    geminiStatus: paymentDetail[0].verification_status,
                    geminiResponse: paymentDetail[0].gemini_response || null
                }
            }
        };

        res.status(200).json(formattedResponse);

    } catch (error) {
        console.error('Error fetching payment details:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};


export const updatePaymentStatus = async (req, res) => {
    try {
        const paymentId = req.body.paymentId;
        const status = req.body.status;
        console.log(paymentId, status, "paymentId, status")

        if (!paymentId) {
            return res.status(400).json({
                success: false,
                message: 'Payment ID is required'
            });
        }

        if (!status) {
            return res.status(400).json({
                success: false,
                message: 'Status is required'
            });
        }

        const validStatuses = ['pending', 'verified', 'rejected'];
        if (!validStatuses.includes(status.toLowerCase())) {
            return res.status(400).json({
                success: false,
                message: 'Invalid status. Must be one of: pending, verified, rejected'
            });
        }

        const [existingPayment] = await pool.execute(
            'SELECT payment_id, verification_status, order_id, shop_id FROM payments WHERE payment_id = ?',
            [paymentId]
        );

        if (!existingPayment || existingPayment.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Payment not found'
            });
        }

        const connection = await pool.getConnection();
        await connection.beginTransaction()

        try {
            await pool.execute(`
                UPDATE payments 
                SET 
                    verification_status = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE payment_id = ?
            `, [status.toLowerCase(), paymentId]);

            let orderStatus = 'pending';
            if (status.toLowerCase() === 'rejected') {
                orderStatus = 'rejected';
                // await incrementAlertCount(order.user_id);
            } else if (status.toLowerCase() === 'verified') {
                orderStatus = 'preparing';
            }

            await pool.execute(`
                UPDATE orders 
                SET 
                    payment_status = ?,
                    status = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE order_id = ?
            `, [status.toLowerCase(), orderStatus, existingPayment[0].order_id]);

            await connection.commit();

            const [updatedPayment] = await pool.execute(`
                SELECT 
                    p.*,
                    o.status as order_status,
                    s.total_revenue as shop_revenue
                FROM payments p
                JOIN orders o ON p.order_id = o.order_id
                JOIN shops s ON p.shop_id = s.id
                WHERE p.payment_id = ?
            `, [paymentId]);

            // After updating the status, get user email and order details
            const [orderDetails] = await connection.execute(`
                SELECT 
                    o.order_id,
                    o.total_price,
                    o.user_id,
                    s.name as shop_name,
                    u.email as user_email,
                    p.payment_method
                FROM orders o
                JOIN shops s ON o.shop_id = s.id
                JOIN users u ON o.user_id = u.id
                JOIN payments p ON o.order_id = p.order_id
                WHERE p.payment_id = ?
            `, [paymentId]);

            const [orderItems] = await connection.execute(`
                SELECT oi.*, mi.name as item_name
                FROM order_items oi
                JOIN menu_items mi ON oi.item_id = mi.item_id
                WHERE oi.order_id = ?
            `, [orderDetails[0].order_id]);

            // Send status update email
            const transporter = nodemailer.createTransport({
                host: 'smtp.gmail.com',
                port: 587,
                secure: false,
                auth: {
                    user: process.env.EMAIL_USER,
                    pass: process.env.EMAIL_PASS
                },
                tls: {
                    rejectUnauthorized: false
                }
            });

            const emailDetails = {
                order_id: orderDetails[0].order_id,
                total_price: orderDetails[0].total_price,
                items: orderItems,
                shop_name: orderDetails[0].shop_name,
                payment_method: orderDetails[0].payment_method,
                payment_status: status.toLowerCase(),
                order_status: orderStatus
            };

            await transporter.sendMail({
                from: process.env.EMAIL_USER,
                to: orderDetails[0].user_email,
                subject: `Order Status Update - Campick NUCES`,
                html: generateOrderConfirmationEmail(emailDetails)
            });

            // Emit payment status update event
            io.emit('paymentStatusUpdate', {
                type: 'payment_update',
                paymentId,
                orderId: existingPayment[0].order_id,
                shopId: existingPayment[0].shop_id,
                status,
                orderStatus,
                timestamp: new Date()
            });

            // Emit to shop-specific channel
            io.emit(`shop_payment_${existingPayment[0].shop_id}`, {
                type: 'payment_update',
                payment: {
                    paymentId,
                    orderId: existingPayment[0].order_id,
                    status,
                    orderStatus
                },
                timestamp: new Date()
            });

            res.status(200).json({
                success: true,
                message: 'Payment status updated successfully',
                data: {
                    paymentId: updatedPayment[0].payment_id,
                    verificationStatus: updatedPayment[0].verification_status,
                    orderStatus: updatedPayment[0].order_status,
                    updatedAt: updatedPayment[0].updated_at
                }
            });

        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }

    } catch (error) {
        console.error('Error updating payment status:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};








// const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);


// export const verifyPaymentAndCreateOrder = async (req, res) => {
//     const { payment_screenshot_url, shop_id, amount, payment_method, items } = req.body;
//     const user_id = req.user.id;
//     const order_id = uuidv4();
//     const payment_id = uuidv4();

//     const connection = await pool.getConnection();

//     try {
//         await connection.beginTransaction();

//         // 1. Validate input
//         if (!payment_screenshot_url || !shop_id || !amount || !payment_method || !items || !items.length) {
//             throw new Error('Missing required fields');
//         }

//         // 2. Create order first
//         await connection.execute(
//             `INSERT INTO orders (
//                 order_id, user_id, shop_id, 
//                 total_price, status, payment_status
//             ) VALUES (?, ?, ?, ?, ?, ?)`,
//             [order_id, user_id, shop_id, amount, 'pending', 'pending']
//         );

//         // 3. Create payment record
//         await connection.execute(
//             `INSERT INTO payments (
//                 payment_id, order_id, user_id, shop_id, 
//                 amount, payment_method, payment_screenshot_url, 
//                 verification_status
//             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
//             [payment_id, order_id, user_id, shop_id, amount, payment_method, 
//              payment_screenshot_url, 'pending']
//         );

//         // 4. Perform OCR on the payment screenshot
//         let ocrResult;
//         try {
//             ocrResult = await performOCR(payment_screenshot_url);
//             // console.log(ocrResult.text, "ocrResult")
            
//             // Update payment record with OCR text
//             await connection.execute(
//                 'UPDATE payments SET ocr_text = ? WHERE payment_id = ?',
//                 [ocrResult.text, payment_id]
//             );
//         } catch (ocrError) {
//             console.error('OCR Error:', ocrError);
//             throw new Error('Failed to process payment screenshot');
//         }

//         // 5. Verify payment amount from OCR
//         const extractedAmount = extractAmountFromOCR(ocrResult.text);
//         console.log(extractedAmount, "extractedAmount")
//         if (!verifyPaymentAmount(extractedAmount, amount)) {
//             throw new Error('Payment amount verification failed');
//         }

//         // 6. Create order items
//         for (const item of items) {
//             // Verify item price and availability
//             const [menuItemResult] = await connection.execute(
//                 'SELECT price FROM menu_items WHERE item_id = ? AND shop_id = ?',
//                 [item.item_id, shop_id]
//             );

//             if (menuItemResult.length === 0) {
//                 throw new Error(`Menu item ${item.item_id} not found or does not belong to the shop`);
//             }

//             const itemPrice = menuItemResult[0].price * item.quantity;

//             await connection.execute(
//                 `INSERT INTO order_items (
//                     order_id, item_id, quantity, price
//                 ) VALUES (?, ?, ?, ?)`,
//                 [order_id, item.item_id, item.quantity, itemPrice]
//             );
//         }

//         // 7. Update payment verification status
//         await connection.execute(
//             'UPDATE payments SET verification_status = ? WHERE payment_id = ?',
//             ['verified', payment_id]
//         );

//         // 8. Update order status and payment status
//         await connection.execute(
//             'UPDATE orders SET status = ?, payment_status = ? WHERE order_id = ?',
//             ['accepted', 'completed', order_id]
//         );

//         // 9. Update shop's total revenue
//         await connection.execute(
//             'UPDATE shops SET total_revenue = total_revenue + ? WHERE id = ?',
//             [amount, shop_id]
//         );

//         await connection.commit();

//         // 10. Fetch complete order details for response
//         const [orderDetails] = await connection.execute(
//             `SELECT o.*, u.user_name, u.email, s.name as shop_name,
//                     p.payment_method, p.payment_screenshot_url
//              FROM orders o
//              JOIN users u ON o.user_id = u.id
//              JOIN shops s ON o.shop_id = s.id
//              JOIN payments p ON o.order_id = p.order_id
//              WHERE o.order_id = ?`,
//             [order_id]
//         );

//         const [orderItems] = await connection.execute(
//             `SELECT oi.*, mi.name as item_name
//              FROM order_items oi
//              JOIN menu_items mi ON oi.item_id = mi.item_id
//              WHERE oi.order_id = ?`,
//             [order_id]
//         );

//         // 11. Emit socket event for real-time updates
//         // const io = req.app.get('io');
//         // io.emit('newOrder', {
//         //     ...orderDetails[0],
//         //     items: orderItems
//         // });

//         res.status(201).json({
//             status: 'success',
//             message: 'Payment verified and order created successfully',
//             order: {
//                 ...orderDetails[0],
//                 items: orderItems
//             }
//         });

//     } catch (error) {
//         await connection.rollback();
//         console.error('Payment verification error:', error);
//         res.status(500).json({
//             status: 'error',
//             message: error.message || 'Failed to verify payment and create order'
//         });
//     } finally {
//         connection.release();
//     }
// };

// // Helper function to perform OCR using Tesseract.js
// const performOCR = async (imageUrl) => {
//     try {
//         const result = await Tesseract.recognize(
//             imageUrl,
//             'eng',
//             {
//                 logger: m => console.log(m)
//             }
//         );
//         return {
//             text: result.data.text,
//             confidence: result.data.confidence,
//             data: result.data
//         };
        
//     } catch (error) {
//         throw new Error('OCR processing failed');
//     }

// };

// const extractAmountFromOCR = (ocrText) => {
//     // Common patterns for payment screenshots, including the new format
//     const patterns = [
//         /amount:?\s*(?:pk?r?|rs\.?)\s*([\d,]+(?:\.\d{2})?)/i,
//         /paid:?\s*(?:pk?r?|rs\.?)\s*([\d,]+(?:\.\d{2})?)/i,
//         /total:?\s*(?:pk?r?|rs\.?)\s*([\d,]+(?:\.\d{2})?)/i,
//         /(?:pk?r?|rs\.?)\s*([\d,]+(?:\.\d{2})?)/i
//     ];

//     for (const pattern of patterns) {
//         const match = ocrText.match(pattern);
//         if (match && match[1]) {
//             // Remove commas and convert to float
//             return parseFloat(match[1].replace(/,/g, ''));
//         }
//     }

//     throw new Error('Could not extract payment amount from screenshot');
// };

// // Helper function to verify payment amount
// const verifyPaymentAmount = (extractedAmount, expectedAmount) => {
//     // Allow for a small difference (e.g., 1%) to account for OCR inaccuracies
//     const tolerance = expectedAmount * 0.01;
//     return Math.abs(extractedAmount - expectedAmount) <= tolerance;
// };