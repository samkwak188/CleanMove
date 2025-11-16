import { NextRequest, NextResponse } from 'next/server';
import { getGeminiApiKey, config } from '@/config';

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('image') as File;

    if (!file) {
      return NextResponse.json(
        { error: 'No image file provided' },
        { status: 400 }
      );
    }

    // Convert the file to base64
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);
    const base64Image = buffer.toString('base64');

    // Get API key from config (checks env variable via getGeminiApiKey)
    const apiKey = getGeminiApiKey();

    if (!apiKey) {
      return NextResponse.json(
        {
          error:
            'No API key configured. Please set GOOGLE_GEMINI_API_KEY in your .env.local (for local dev) or in your hosting environment variables.',
        },
        { status: 400 }
      );
    }

    console.log('🔑 API key found, calling Gemini REST API...');

    // Use REST API directly (v1, not v1beta)
    const prompt = `
You are reading a MOVE-IN / MOVE-OUT house condition checklist.

Your job:
- Extract ONLY the individual things in the home that a tenant should inspect.
- Many checklists are organized into sections (categories/rooms) with items underneath.
- If the same kind of item appears under different sections, treat each one as a separate checklist item.

VERY IMPORTANT CATEGORY RULES (FRONTEND DEPENDS ON THIS FORMAT):
- When an item clearly belongs to a section / room / category, append the category at the END of the string in brackets.
- Use either square brackets or parentheses exactly like this:
  - Walls [Kitchen]
  - Closet door (Bedroom 1)
- The part before the brackets must be the specific thing to inspect.
- The part inside the brackets/parentheses must be ONLY the category/room name.
- If there is no clear category/room, output just the item text with NO brackets.

DO NOT return:
- Column headings or table labels (for example labels like: column titles, checkboxes, status words).
- Section titles that are just category names, unless the text clearly means "inspect the entire room/area".
- Page titles, dates, signatures, landlord/tenant names, addresses, or any meta information.

Output format (JSON ONLY):
{
  "items": [
    "Walls [Kitchen]",
    "Ceiling [Living Room]",
    "Bathroom mirror (Primary Bathroom)"
  ]
}

Requirements:
- Each string must describe a PHYSICAL AREA, SURFACE, FIXTURE or PIECE OF EQUIPMENT in the property to inspect.
- If the same textual item appears under different sections/categories, you MUST still include each one as its own string, with its own bracketed category.
- Do NOT include headings or labels that are not real things in the property.
`.trim();

    console.log('📤 Sending image to Gemini API...');
    console.log('📊 Image size:', (base64Image.length / 1024).toFixed(2), 'KB');
    console.log('📝 MIME type:', file.type);

    // Try v1 API with a vision-capable model (gemini-2.5-flash supports images)
    const apiUrl = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    
    const requestBody = {
      contents: [{
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: file.type,
              data: base64Image
            }
          }
        ]
      }]
    };

    console.log('🌐 Calling Gemini v1 API...');

    try {
      const apiResponse = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      if (!apiResponse.ok) {
        const errorText = await apiResponse.text();
        console.error('❌ API returned error:', apiResponse.status, errorText);
        return NextResponse.json(
          { 
            error: `Gemini API error: ${apiResponse.status} ${apiResponse.statusText}`,
            details: errorText.substring(0, 500)
          },
          { status: 500 }
        );
      }

      const data = await apiResponse.json();
      console.log('✅ Got response from Gemini');
      
      // Extract text from Gemini response format
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!text) {
        console.error('❌ Empty response from Gemini');
        console.error('Response structure:', JSON.stringify(data, null, 2).substring(0, 500));
        return NextResponse.json(
          { error: 'Empty response from Gemini API', details: JSON.stringify(data) },
          { status: 500 }
        );
      }

      console.log('📄 Response preview:', text.substring(0, 200));

      // Parse the JSON response from Gemini
      let parsedContent: { items?: unknown[] } = {};
      try {
        // Remove markdown code blocks if present
        const cleanContent = text.replace(/```json\n?|\n?```/g, '').trim();
        console.log('🔍 Attempting to parse JSON...');
        parsedContent = JSON.parse(cleanContent) as { items?: unknown[] };
        console.log(
          '✅ JSON parsed successfully, items:',
          Array.isArray(parsedContent.items) ? parsedContent.items.length : 0
        );
      } catch (parseError: any) {
        console.error('❌ Failed to parse as JSON:', parseError.message);
        console.error('📄 Raw response:', text);
        
        return NextResponse.json(
          { 
            error: 'Failed to parse Gemini response as JSON',
            details: text.substring(0, 500),
            parseError: parseError.message
          },
          { status: 500 }
        );
      }

      // Validate and clean the response items
      if (!parsedContent.items || !Array.isArray(parsedContent.items)) {
        console.error('❌ Response missing items array');
        return NextResponse.json(
          { 
            error: 'Invalid response format from Gemini',
            details: 'Expected { items: [...] }',
            received: parsedContent
          },
          { status: 500 }
        );
      }

      const stopwords = new Set(
        [
          'item',
          'items',
          'entry',
          'exit',
          'condition',
          'conditions',
          'notes',
          'comments',
          'yes',
          'no',
          'n/a',
          'na',
          'ok',
          'good',
          'fair',
          'poor',
          'date',
          'inspector',
          'tenant',
          'landlord',
          'initials',
        ].map((s) => s.toLowerCase())
      );

      const cleanedItems = (parsedContent.items as unknown[])
        .map((item) => String(item).trim())
        .filter((item) => item.length >= 3)
        // keep all real items, but drop pure headings/labels
        .filter((item) => !stopwords.has(item.toLowerCase()));

      if (!cleanedItems.length) {
        console.error('❌ No valid checklist items after cleaning', parsedContent.items);
        return NextResponse.json(
          { 
            error: 'No valid checklist items found in the image after filtering headings/labels.',
            details: parsedContent.items
          },
          { status: 500 }
        );
      }

      console.log('🎉 Success! Returning', cleanedItems.length, 'cleaned items');
      return NextResponse.json({ items: cleanedItems });

    } catch (fetchError: any) {
      console.error('❌ Fetch error:', fetchError);
      console.error('Error details:', {
        message: fetchError.message,
        cause: fetchError.cause,
      });
      
      return NextResponse.json(
        { 
          error: `Network error: ${fetchError.message}`,
          details: fetchError.toString(),
        },
        { status: 500 }
      );
    }
  } catch (error: any) {
    console.error('❌ Unexpected error:', error);
    return NextResponse.json(
      { 
        error: 'Internal server error',
        details: error.message,
        stack: error.stack?.substring(0, 500)
      },
      { status: 500 }
    );
  }
}
