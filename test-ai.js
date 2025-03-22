// Import the Google Generative AI library
const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();

// Get API key from environment variables
const apiKey = process.env.GEMINI_API_KEY;

// Initialize the API client
const genAI = new GoogleGenerativeAI(apiKey);

// List available models using the model properties
async function testAvailableModels() {
  try {
    // Create a model instance
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    
    // Test simple content generation
    console.log("Testing model: gemini-2.0-flash");
    const result = await model.generateContent("Explain how AI works in 3 sentences.");
    console.log("Response:", result.response.text());
    console.log("\nTest completed successfully!");
  } catch (error) {
    console.error('Error testing model:', error);
  }
}

// Run the function
testAvailableModels(); 