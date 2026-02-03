const fetch = require('node-fetch');

exports.handler = async (event, context) => {
    // CORS headers
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Content-Type': 'application/json'
    };

    // Handle preflight requests
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    // Only allow POST
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers,
            body: JSON.stringify({ error: 'Method not allowed' })
        };
    }

    try {
        const { location, mood, timeAvailable, maxDistance } = JSON.parse(event.body);

        if (!location || !mood) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Location and mood are required' })
            };
        }

        // Get places from Foursquare (optional - can work without it)
        let places = [];
        if (process.env.FOURSQUARE_API_KEY) {
            places = await getPlacesFromFoursquare(location, mood, maxDistance);
        }

        // Get AI recommendations from Gemini
        const recommendations = await getGeminiRecommendations(
            location,
            mood,
            timeAvailable,
            maxDistance,
            places
        );

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ recommendations })
        };

    } catch (error) {
        console.error('Error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to get recommendations' })
        };
    }
};

async function getPlacesFromFoursquare(location, mood, maxDistance) {
    const moodToCategory = {
        'coffee': '13035', // Coffee shops
        'quick-bite': '13145', // Fast food
        'healthy': '13377', // Health food
        'comfort': '13065', // Restaurants
        'date-night': '13003', // Fine dining
        'adventure': '13000'  // All food
    };

    const categoryId = moodToCategory[mood] || '13000';

    try {
        const response = await fetch(
            `https://api.foursquare.com/v3/places/search?query=restaurant&near=${encodeURIComponent(location)}&categories=${categoryId}&limit=5&radius=${maxDistance}`,
            {
                headers: {
                    'Authorization': process.env.FOURSQUARE_API_KEY,
                    'Accept': 'application/json'
                }
            }
        );

        if (!response.ok) {
            console.log('Foursquare API error:', response.status);
            return [];
        }

        const data = await response.json();
        return data.results || [];
    } catch (error) {
        console.error('Foursquare error:', error);
        return [];
    }
}

async function getGeminiRecommendations(location, mood, timeAvailable, maxDistance, places) {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

    if (!GEMINI_API_KEY) {
        // Return mock recommendations if no API key
        return getMockRecommendations(mood);
    }

    const moodDescriptions = {
        'coffee': 'looking for a great coffee shop or cafe',
        'quick-bite': 'need a quick and satisfying meal',
        'healthy': 'want healthy, nutritious food options',
        'comfort': 'craving comfort food',
        'date-night': 'planning a romantic dinner',
        'adventure': 'want to try something new and exciting'
    };

    const placesContext = places.length > 0
        ? `Here are some real places in the area to consider: ${places.map(p => p.name).join(', ')}.`
        : '';

    const currentTime = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: 'numeric', hour12: true, weekday: 'long' });

    const prompt = `You are a helpful restaurant recommendation assistant. A user in ${location} is ${moodDescriptions[mood] || 'looking for food'}. They have ${timeAvailable} minutes and can travel up to ${maxDistance} meters.

Current time: ${currentTime}

${placesContext}

IMPORTANT RULES:
1. ONLY recommend major chains or well-established franchises (like Starbucks, Peet's Coffee, Dutch Bros, Panera, Chipotle, etc.) that are guaranteed to still be in business
2. DO NOT recommend small local cafes or independent restaurants as they may have closed
3. Only recommend places likely to be OPEN at this time based on typical business hours
4. Focus on popular, nationwide or regional chains with multiple locations

Please provide 2-3 restaurant recommendations. For each recommendation, provide:
1. A major chain or well-established franchise name that has locations in ${location}
2. A brief, engaging description of why it fits their mood
3. Estimated distance/time if applicable
4. Typical hours to confirm it's likely open now

Format your response as a JSON array with objects containing: name, description, address (optional), distance (optional), rating (optional), hours (optional).

Example format:
[
  {"name": "Starbucks Reserve", "description": "Perfect cozy spot for your coffee craving with artisanal brews and fresh pastries.", "distance": "5 min walk", "hours": "Open until 9 PM"},
  {"name": "Sweetgreen", "description": "Fresh, healthy options with amazing grain bowls and smoothies.", "distance": "10 min walk", "hours": "Open until 10 PM"}
]

Respond ONLY with the JSON array, no other text.`;

    try {
        const response = await fetch(
            'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': GEMINI_API_KEY
                },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        temperature: 0.7,
                        maxOutputTokens: 1024
                    }
                })
            }
        );

        if (!response.ok) {
            const errorText = await response.text();
            console.error('Gemini API error:', response.status, errorText);
            return getMockRecommendations(mood);
        }

        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!text) {
            return getMockRecommendations(mood);
        }

        // Extract JSON from response
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }

        return getMockRecommendations(mood);
    } catch (error) {
        console.error('Gemini error:', error);
        return getMockRecommendations(mood);
    }
}

function getMockRecommendations(mood) {
    const mockData = {
        'coffee': [
            { name: "Brew & Bean Cafe", description: "Cozy corner cafe with artisanal coffee and fresh pastries. Perfect for your caffeine fix!", distance: "5 min walk" },
            { name: "The Daily Grind", description: "Hip coffee spot with excellent espresso drinks and comfortable seating.", distance: "8 min walk" }
        ],
        'quick-bite': [
            { name: "Urban Eats", description: "Fast-casual spot with delicious wraps, bowls, and sandwiches ready in minutes.", distance: "3 min walk" },
            { name: "Grab & Go Grill", description: "Quick service restaurant with tasty burgers and fresh-cut fries.", distance: "5 min walk" }
        ],
        'healthy': [
            { name: "Green Leaf Kitchen", description: "Farm-to-table salads, grain bowls, and fresh smoothies for the health-conscious.", distance: "7 min walk" },
            { name: "Vitality Cafe", description: "Nutrient-packed meals with vegan and gluten-free options available.", distance: "10 min walk" }
        ],
        'comfort': [
            { name: "Mama's Kitchen", description: "Hearty comfort food classics like mac & cheese, meatloaf, and pot pie.", distance: "8 min walk" },
            { name: "The Cozy Corner", description: "Warm, inviting spot serving up comfort favorites with a modern twist.", distance: "12 min walk" }
        ],
        'date-night': [
            { name: "Bella Notte", description: "Romantic Italian restaurant with candlelit tables and an extensive wine list.", distance: "10 min drive" },
            { name: "The Secret Garden", description: "Upscale dining with a beautiful patio setting, perfect for a special evening.", distance: "15 min drive" }
        ],
        'adventure': [
            { name: "Spice Route", description: "Explore bold flavors from around the world with rotating international menus.", distance: "12 min drive" },
            { name: "Fusion Alley", description: "Creative fusion cuisine that combines unexpected ingredients in delightful ways.", distance: "8 min walk" }
        ]
    };

    return mockData[mood] || mockData['quick-bite'];
}
