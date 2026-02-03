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

        let recommendations;
        let source = 'foursquare'; // Track data source
        let rateLimitReached = false;

        // Try Foursquare first for real, verified places
        if (process.env.FOURSQUARE_API_KEY) {
            const foursquareResult = await getPlacesFromFoursquare(location, mood, maxDistance);

            if (foursquareResult.rateLimited) {
                // Foursquare rate limit reached, fallback to Gemini
                rateLimitReached = true;
                source = 'ai';
                recommendations = await getGeminiRecommendations(location, mood, timeAvailable, maxDistance);
            } else if (foursquareResult.places.length > 0) {
                // Enhance Foursquare results with AI descriptions
                recommendations = await enhanceWithGemini(foursquareResult.places, mood, location);
            } else {
                // No Foursquare results, fallback to Gemini-only
                source = 'ai';
                recommendations = await getGeminiRecommendations(location, mood, timeAvailable, maxDistance);
            }
        } else {
            // No Foursquare key, use Gemini only
            source = 'ai';
            recommendations = await getGeminiRecommendations(location, mood, timeAvailable, maxDistance);
        }

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                recommendations,
                source,
                rateLimitReached,
                message: rateLimitReached
                    ? 'Live data temporarily unavailable. Showing AI-generated recommendations.'
                    : null
            })
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
    const moodToQuery = {
        'coffee': 'coffee',
        'quick-bite': 'fast food',
        'healthy': 'healthy food salad',
        'comfort': 'comfort food american',
        'date-night': 'fine dining romantic',
        'adventure': 'unique restaurant'
    };

    const moodToCategory = {
        'coffee': '13035',      // Coffee shops
        'quick-bite': '13145',  // Fast food
        'healthy': '13377',     // Health food
        'comfort': '13065',     // Restaurants
        'date-night': '13003',  // Bars (often fine dining)
        'adventure': '13000'    // Dining and Drinking
    };

    const query = moodToQuery[mood] || 'restaurant';
    const categoryId = moodToCategory[mood] || '13000';

    try {
        // Search for places
        const searchResponse = await fetch(
            `https://api.foursquare.com/v3/places/search?query=${encodeURIComponent(query)}&near=${encodeURIComponent(location)}&categories=${categoryId}&limit=5&sort=RELEVANCE&open_now=true`,
            {
                headers: {
                    'Authorization': process.env.FOURSQUARE_API_KEY,
                    'Accept': 'application/json'
                }
            }
        );

        // Check for rate limiting (429) or quota exceeded (402)
        if (searchResponse.status === 429 || searchResponse.status === 402) {
            console.log('Foursquare rate limit reached:', searchResponse.status);
            return { places: [], rateLimited: true };
        }

        if (!searchResponse.ok) {
            const errorText = await searchResponse.text();
            console.log('Foursquare search error:', searchResponse.status, errorText);
            return { places: [], rateLimited: false };
        }

        const searchData = await searchResponse.json();
        const places = searchData.results || [];

        // Get detailed info for each place
        const detailedPlaces = await Promise.all(
            places.slice(0, 3).map(async (place) => {
                try {
                    const detailResponse = await fetch(
                        `https://api.foursquare.com/v3/places/${place.fsq_id}?fields=name,location,hours,rating,price,categories,distance`,
                        {
                            headers: {
                                'Authorization': process.env.FOURSQUARE_API_KEY,
                                'Accept': 'application/json'
                            }
                        }
                    );

                    if (detailResponse.ok) {
                        const detail = await detailResponse.json();
                        return {
                            name: detail.name,
                            address: formatAddress(detail.location),
                            distance: place.distance ? `${Math.round(place.distance)} meters` : null,
                            rating: detail.rating ? `${detail.rating}/10` : null,
                            price: detail.price ? '$'.repeat(detail.price) : null,
                            hours: formatHours(detail.hours),
                            category: detail.categories?.[0]?.name || null
                        };
                    }
                    return {
                        name: place.name,
                        address: formatAddress(place.location),
                        distance: place.distance ? `${Math.round(place.distance)} meters` : null
                    };
                } catch (err) {
                    console.error('Error fetching place details:', err);
                    return {
                        name: place.name,
                        address: formatAddress(place.location),
                        distance: place.distance ? `${Math.round(place.distance)} meters` : null
                    };
                }
            })
        );

        return { places: detailedPlaces.filter(p => p !== null), rateLimited: false };
    } catch (error) {
        console.error('Foursquare error:', error);
        return { places: [], rateLimited: false };
    }
}

function formatAddress(location) {
    if (!location) return null;
    const parts = [];
    if (location.address) parts.push(location.address);
    if (location.locality) parts.push(location.locality);
    if (location.region) parts.push(location.region);
    if (location.postcode) parts.push(location.postcode);
    return parts.join(', ') || null;
}

function formatHours(hours) {
    if (!hours || !hours.display) return null;

    // Get today's hours
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long' });
    const todayHours = hours.regular?.find(h => {
        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        return days[h.day] === today;
    });

    if (todayHours) {
        return `Open ${todayHours.open}-${todayHours.close}`;
    }

    return hours.open_now ? 'Open now' : 'Check hours';
}

async function enhanceWithGemini(places, mood, location) {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

    if (!GEMINI_API_KEY) {
        // Return Foursquare data with generic descriptions
        return places.map(place => ({
            ...place,
            description: `A great ${mood} spot in ${location}.`
        }));
    }

    const moodDescriptions = {
        'coffee': 'looking for a great coffee shop or cafe',
        'quick-bite': 'needs a quick and satisfying meal',
        'healthy': 'wants healthy, nutritious food options',
        'comfort': 'is craving comfort food',
        'date-night': 'is planning a romantic dinner',
        'adventure': 'wants to try something new and exciting'
    };

    const placesInfo = places.map(p => `- ${p.name} (${p.category || 'restaurant'})`).join('\n');

    const prompt = `A user ${moodDescriptions[mood] || 'is looking for food'} in ${location}.

Here are real places they could visit:
${placesInfo}

For each place, write a brief, engaging 1-2 sentence description of why it would be great for their mood. Be specific and enthusiastic.

Format your response as a JSON array with objects containing just "name" and "description".

Example:
[
  {"name": "Starbucks", "description": "Perfect for a cozy coffee break with their signature lattes and comfortable seating."},
  {"name": "Peet's Coffee", "description": "Known for bold, rich roasts that will energize your day."}
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
            console.error('Gemini API error:', response.status);
            return places.map(place => ({
                ...place,
                description: `A popular ${mood} destination.`
            }));
        }

        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

        if (text) {
            const jsonMatch = text.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
                const descriptions = JSON.parse(jsonMatch[0]);

                // Merge AI descriptions with Foursquare data
                return places.map(place => {
                    const aiData = descriptions.find(d =>
                        d.name.toLowerCase() === place.name.toLowerCase() ||
                        place.name.toLowerCase().includes(d.name.toLowerCase()) ||
                        d.name.toLowerCase().includes(place.name.toLowerCase())
                    );
                    return {
                        ...place,
                        description: aiData?.description || `A great ${mood} spot worth checking out.`
                    };
                });
            }
        }

        return places.map(place => ({
            ...place,
            description: `A popular ${mood} destination.`
        }));

    } catch (error) {
        console.error('Gemini error:', error);
        return places.map(place => ({
            ...place,
            description: `A great ${mood} spot in ${location}.`
        }));
    }
}

async function getGeminiRecommendations(location, mood, timeAvailable, maxDistance) {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

    if (!GEMINI_API_KEY) {
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

    const currentTime = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: 'numeric', hour12: true, weekday: 'long' });

    const prompt = `You are a helpful restaurant recommendation assistant. A user in ${location} is ${moodDescriptions[mood] || 'looking for food'}. They have ${timeAvailable} minutes and can travel up to ${maxDistance} meters.

Current time: ${currentTime}

IMPORTANT RULES:
1. ONLY recommend major chains or well-established franchises (like Starbucks, Peet's Coffee, Dutch Bros, Panera, Chipotle, etc.) that are guaranteed to still be in business
2. DO NOT recommend small local cafes or independent restaurants as they may have closed
3. Only recommend places likely to be OPEN at this time based on typical business hours
4. Focus on popular, nationwide or regional chains with multiple locations

Please provide 2-3 restaurant recommendations. For each recommendation, provide:
1. A major chain or well-established franchise name that has locations in ${location}
2. The specific street address of a real location in ${location}
3. A brief, engaging description of why it fits their mood
4. Estimated distance/time if applicable
5. Typical hours to confirm it's likely open now

Format your response as a JSON array with objects containing: name, description, address, distance, rating (optional), hours.

Example format:
[
  {"name": "Starbucks Reserve", "address": "123 Main St, Seattle, WA 98101", "description": "Perfect cozy spot for your coffee craving with artisanal brews and fresh pastries.", "distance": "5 min walk", "hours": "Open until 9 PM"},
  {"name": "Sweetgreen", "address": "456 Pike St, Seattle, WA 98101", "description": "Fresh, healthy options with amazing grain bowls and smoothies.", "distance": "10 min walk", "hours": "Open until 10 PM"}
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
            { name: "Starbucks", address: "Multiple locations", description: "Cozy corner cafe with artisanal coffee and fresh pastries. Perfect for your caffeine fix!", distance: "5 min walk", hours: "Open now" },
            { name: "Peet's Coffee", address: "Multiple locations", description: "Known for bold, rich roasts and excellent espresso drinks.", distance: "8 min walk", hours: "Open now" }
        ],
        'quick-bite': [
            { name: "Chipotle", address: "Multiple locations", description: "Fast-casual spot with delicious burritos and bowls ready in minutes.", distance: "3 min walk", hours: "Open now" },
            { name: "Panera Bread", address: "Multiple locations", description: "Quick service restaurant with fresh sandwiches and soups.", distance: "5 min walk", hours: "Open now" }
        ],
        'healthy': [
            { name: "Sweetgreen", address: "Multiple locations", description: "Farm-to-table salads and grain bowls for the health-conscious.", distance: "7 min walk", hours: "Open now" },
            { name: "Panera Bread", address: "Multiple locations", description: "Nutrient-packed meals with healthy options available.", distance: "10 min walk", hours: "Open now" }
        ],
        'comfort': [
            { name: "Applebee's", address: "Multiple locations", description: "Hearty comfort food classics and American favorites.", distance: "8 min drive", hours: "Open now" },
            { name: "Chili's", address: "Multiple locations", description: "Warm, inviting spot serving up comfort favorites.", distance: "12 min drive", hours: "Open now" }
        ],
        'date-night': [
            { name: "The Cheesecake Factory", address: "Multiple locations", description: "Upscale casual dining with an extensive menu perfect for date night.", distance: "10 min drive", hours: "Open now" },
            { name: "Olive Garden", address: "Multiple locations", description: "Italian classics in a romantic atmosphere.", distance: "15 min drive", hours: "Open now" }
        ],
        'adventure': [
            { name: "P.F. Chang's", address: "Multiple locations", description: "Explore bold Asian-inspired flavors and creative dishes.", distance: "12 min drive", hours: "Open now" },
            { name: "Benihana", address: "Multiple locations", description: "Japanese hibachi experience with entertaining chefs.", distance: "15 min drive", hours: "Open now" }
        ]
    };

    return mockData[mood] || mockData['quick-bite'];
}
