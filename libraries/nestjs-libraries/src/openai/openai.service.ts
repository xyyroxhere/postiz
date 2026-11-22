import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import { shuffle } from 'lodash';
import { z } from 'zod';

// Groq client for fast text completions (OpenAI-compatible API)
const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY || '',
  baseURL: 'https://api.groq.com/openai/v1',
});

const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

// Gemini client for image generation (OpenAI-compatible endpoint)
const gemini = new OpenAI({
  apiKey: process.env.GEMINI_API_KEY || '',
  baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
});

// Helper: Groq supports json_object mode but not zodResponseFormat/parse.
// We ask for JSON in the system prompt and parse manually.
async function groqJsonCompletion<T>(
  systemPrompt: string,
  userContent: string,
  schema: z.ZodType<T>
): Promise<T> {
  const response = await groq.chat.completions.create({
    model: GROQ_MODEL,
    messages: [
      { role: 'system', content: systemPrompt + '\n\nRespond ONLY with valid JSON matching the requested schema. No markdown, no code fences.' },
      { role: 'user', content: userContent },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.7,
  });

  const raw = response.choices[0].message.content || '{}';
  return schema.parse(JSON.parse(raw));
}

const PicturePrompt = z.object({
  prompt: z.string(),
});

const VoicePrompt = z.object({
  voice: z.string(),
});

const ClipsPrompt = z.object({
  clips: z.array(
    z.object({
      from: z.number(),
      to: z.number(),
      title: z.string(),
      content: z.string(),
    })
  ),
});

@Injectable()
export class OpenaiService {
  async pickClips(
    title: string,
    language: string,
    segments: { start: number; end: number; text: string }[],
    maxClips: number
  ) {
    const systemPrompt = `You are an assistant that takes the transcript of a video and picks the parts that will work best as short vertical clips for social media.
Every line of the transcript is "number [start seconds - end seconds] text".
Pick up to ${maxClips} clips, best first. A clip is a range of consecutive lines that starts with a hook, makes one complete point and is understandable without the rest of the video.
The length of a clip is the end of its last line minus the start of its first line: it must be between 20 and 90 seconds, never longer, so check the numbers before answering.
Clips must not overlap. Write the title and the post in this language, whatever the language of these instructions: ${language}.
Return JSON: { "clips": [{ "from": number, "to": number, "title": string, "content": string }] }`;

    const userContent = `title: ${title}\n\n${segments
      .map(
        (p, index) =>
          `${index} [${p.start.toFixed(1)} - ${p.end.toFixed(1)}] ${p.text}`
      )
      .join('\n')}`;

    const result = await groqJsonCompletion(systemPrompt, userContent, ClipsPrompt);
    return result.clips;
  }

  async generateImage(prompt: string, isVertical = false) {
    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) {
      throw new Error('GEMINI_API_KEY is not configured in .env');
    }

    const aspectRatio = isVertical ? '9:16' : '1:1';

    // 1. Try Imagen 3 via Google Generative Language predict endpoint
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${geminiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instances: [{ prompt }],
          parameters: {
            sampleCount: 1,
            aspectRatio,
            outputOptions: { mimeType: 'image/jpeg' },
          },
        }),
      });

      if (res.ok) {
        const data = await res.json() as any;
        const b64 = data?.predictions?.[0]?.bytesBase64Encoded;
        if (b64) return b64;
      }
    } catch (err) {
      console.warn('Imagen 3 predict call error:', err);
    }

    // 2. Fallback to OpenAI-compatible endpoint if available
    try {
      const response = await gemini.images.generate({
        prompt,
        model: 'imagen-3.0-generate-002',
        size: isVertical ? '1024x1536' : '1024x1024',
        response_format: 'b64_json',
      } as any);

      const imageData = (response as any).data?.[0]?.b64_json;
      if (imageData) return imageData;
    } catch (err) {
      console.warn('Gemini OpenAI-compatible images.generate fallback error:', err);
    }

    throw new Error('Image generation failed. Please ensure GEMINI_API_KEY is valid and has Imagen 3 access enabled.');
  }

  async generatePromptForPicture(prompt: string) {
    const result = await groqJsonCompletion(
      `You are an assistant that take a description and style and generate a prompt that will be used later to generate images, make it a very long and descriptive explanation, and write a lot of things for the renderer like, if it's realistic describe the camera. Return JSON: { "prompt": string }`,
      `prompt: ${prompt}`,
      PicturePrompt
    );
    return result.prompt;
  }

  async generateVoiceFromText(prompt: string) {
    const result = await groqJsonCompletion(
      `You are an assistant that takes a social media post and convert it to a normal human voice, to be later added to a character, when a person talk they don't use "-", and sometimes they add pause with "..." to make it sounds more natural, make sure you use a lot of pauses and make it sound like a real person. Return JSON: { "voice": string }`,
      `prompt: ${prompt}`,
      VoicePrompt
    );
    return result.voice;
  }

  async generatePosts(content: string) {
    const posts = (
      await Promise.all(
        [
          'Generate a Twitter post from the content without emojis in the following JSON format: { "post": string } put it in an array with one element',
          'Generate a thread for social media in the following JSON format: Array<{ "post": string }> without emojis',
        ].flatMap((prompt) =>
          [...new Array(5)].map(() =>
            groq.chat.completions.create({
              messages: [
                {
                  role: 'assistant',
                  content: prompt,
                },
                {
                  role: 'user',
                  content: content!,
                },
              ],
              temperature: 1,
              model: GROQ_MODEL,
            })
          )
        )
      )
    ).flatMap((p) => p.choices);

    return shuffle(
      posts.map((choice) => {
        const { content } = choice.message;
        const start = content?.indexOf('[')!;
        const end = content?.lastIndexOf(']')!;
        try {
          return JSON.parse(
            '[' +
              content
                ?.slice(start + 1, end)
                .replace(/\n/g, ' ')
                .replace(/ {2,}/g, ' ') +
              ']'
          );
        } catch (e) {
          return [];
        }
      })
    );
  }

  async extractWebsiteText(content: string) {
    const websiteContent = await groq.chat.completions.create({
      messages: [
        {
          role: 'assistant',
          content:
            'You take a full website text, and extract only the article content',
        },
        {
          role: 'user',
          content,
        },
      ],
      model: GROQ_MODEL,
    });

    const { content: articleContent } = websiteContent.choices[0].message;

    return this.generatePosts(articleContent!);
  }

  async separatePosts(content: string, len: number) {
    const SeparatePostsPrompt = z.object({
      posts: z.array(z.string()),
    });

    const posts = (
      await groqJsonCompletion(
        `You are an assistant that take a social media post and break it to a thread, each post must be minimum ${
          len - 10
        } and maximum ${len} characters, keeping the exact wording and break lines, however make sure you split posts based on context. Return JSON: { "posts": string[] }`,
        content,
        SeparatePostsPrompt
      )
    ).posts;

    return {
      posts: await Promise.all(
        posts.map(async (post: any) => {
          if (post.length <= len) {
            return post;
          }

          let retries = 4;
          while (retries) {
            try {
              const result = await groqJsonCompletion(
                `You are an assistant that take a social media post and shrink it to be maximum ${len} characters, keeping the exact wording and break lines. Return JSON: { "post": string }`,
                post,
                z.object({ post: z.string() })
              );
              return result.post;
            } catch (e) {
              retries--;
            }
          }

          return post;
        })
      ),
    };
  }

  async generateSlidesFromText(text: string) {
    const SlidesSchema = z.object({
      slides: z.array(
        z.object({
          imagePrompt: z.string(),
          voiceText: z.string(),
        })
      ),
    });

    for (let i = 0; i < 3; i++) {
      try {
        const result = await groqJsonCompletion(
          `You are an assistant that takes a text and break it into slides, each slide should have an image prompt and voice text to be later used to generate a video and voice, image prompt should capture the essence of the slide and also have a back dark gradient on top, image prompt should not contain text in the picture, generate between 3-5 slides maximum. Return JSON: { "slides": [{ "imagePrompt": string, "voiceText": string }] }`,
          text,
          SlidesSchema
        );
        return result.slides;
      } catch (err) {
        console.log(err);
      }
    }

    return [];
  }
}
