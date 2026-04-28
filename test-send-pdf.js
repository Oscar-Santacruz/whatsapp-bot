import fs from 'fs'
import path from 'path'

// Configuration
const BOT_URL = 'http://localhost:3001'; // Point to local bot
const BOT_TOKEN = 'test-secret-local'; // Use your actual API_TOKEN
const TARGET_PHONE = '595961853895'; // REPLACE WITH YOUR PHONE NUMBER (e.g., 595981123456)

async function testSendPDF() {
    console.log('--- Testing WhatsApp Bot PDF Export ---');

    // 1. Create a dummy base64 PDF string (or use a real small file)
    // For this test, we'll create a very simple "Hello World" PDF structure in base64
    // Alternatively, if you have a real pdf, you can read it:
    // const base64File = fs.readFileSync('receipt.pdf').toString('base64');

    const base64File = 'JVBERi0xLjQKMSAwIG9iajw8L1R5cGUvQ2F0YWxvZy9QYWdlcyAyIDAgUj4+ZW5kb2JqMiAwIG9iajw8L1R5cGUvUGFnZXMvS2lkc1szIDAgUl0vQ291bnQgMT4+ZW5kb2JqMyAwIG9iajw8L1R5cGUvUGFnZS9QYXJlbnQgMiAwIFIvTWVkaWFCb3hbMCAwIDYxMiA3OTJdL0NvbnRlbnRzIDQgMCBSPj5lbmRvYmo0IDAgb2JqPDwvTGVuZ3RoIDY1Pj5zdHJlYW0KQlQKIFRkCiAoVGVzdCBkZSBSZWNpYm8gY2FyLXNhbGUpIFRqCkVUCmVuZHN0cmVhbQplbmRvYmoKeHJlZgowIDUKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTYgMDAwMDAgbiAKMDAwMDAwMDExMSAwMDAwMCBuIAowMDAwMDAwMjEyIDAwMDAwIG4gCnRyYWlsZXIKPDwvU2l6ZSA1L1Jvb3QgMSAwIFI+PgpzdGFydHhyZWYKMzI2CiUlRU9G';

    const payload = {
        phone: TARGET_PHONE,
        file: base64File,
        fileName: 'test-recibo.pdf',
        mimetype: 'application/pdf'
    };

    try {
        console.log(`Sending PDF to ${TARGET_PHONE}...`);
        const response = await fetch(`${BOT_URL}/send-document`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${BOT_TOKEN}`
            },
            body: JSON.stringify(payload)
        });

        const result = await response.text();
        if (response.ok) {
            console.log('✅ Success:', result);
        } else {
            console.error('❌ Error:', response.status, result);
        }
    } catch (error) {
        console.error('❌ Fetch Error:', error.message);
    }
}

testSendPDF();
