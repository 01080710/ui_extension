'use strict';

/**
 * Prompts and tool schemas. Enums come from the extension's config, so the AI can
 * only suggest choices the cards can show.
 */

const obj = (properties) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});

const questionSchema = obj({
  id: { type: 'string', description: 'Short snake_case id, unique in this list.' },
  question: { type: 'string', description: 'One short question in the user locale.' },
  options: { type: 'array', items: { type: 'string' }, description: '2 to 6 short, concrete answers.' },
  required: { type: 'boolean', description: 'True only if the answer changes the generated code.' },
});

function analyzeTool(PACK) {
  const stack = obj(Object.fromEntries(PACK.stackFields.map((f) => [f.id, { type: 'string', enum: PACK.stack[f.id].map((x) => x.id) }])));
  const modes = PACK.assetModes.map((m) => m.id);
  const assets = obj(Object.fromEntries(PACK.assetKinds.map((k) => [k.id, { type: 'string', enum: modes }])));
  return {
    name: 'report_analysis',
    description: 'Report the analysis of the captured page section. Call it exactly once.',
    strict: true,
    input_schema: obj({
      suggested: obj({ stack, assets }),
      summary: { type: 'string', description: 'One sentence in the user locale: what was captured and what you recommend.' },
      questions: { type: 'array', items: questionSchema },
    }),
  };
}

function analyzeSystem(PACK) {
  return [
    'You analyse a captured section of a web page so a developer can rebuild it as a small front-end project.',
    'The capture is JSON: a DOM tree (t = tag, r = [x, y, width, height] in CSS px relative to the viewport, a = attributes, s = computed styles, c = children; strings are text), small SVG icons as path data, image URLs, font families, and optionally the design-token files of the theme the user picked.',
    '',
    'Recommend a stack and how to handle images, fonts and icons. Prefer React + TypeScript + Tailwind unless the capture suggests otherwise; prefer "bundle" for images when they are few and essential, "placeholder" when they are photos of changing content, and "link" for fonts on Google Fonts.',
    'The user confirms the stack and asset handling on separate cards, so never ask about them.',
    `Ask questions only about uncertainties that would change the generated code, for example whether a carousel should rotate, or whether a menu should open on hover or click. Mark those required: true, at most ${PACK.maxRequiredQuestions}. If nothing is uncertain, return an empty list. Do not ask about taste or about things the capture already shows.`,
    'Write the summary, questions and options in the locale given by the user.',
    'Answer by calling report_analysis.',
  ].join('\n');
}

function generateTools() {
  return [
    {
      name: 'emit_project',
      description: 'Return every file of the finished project. Call once.',
      eager_input_streaming: true,
      input_schema: obj({
        files: {
          type: 'array',
          items: obj({
            path: { type: 'string', description: 'Relative POSIX path, e.g. src/App.tsx' },
            content: { type: 'string', description: 'Full file content (text only).' },
          }),
        },
      }),
    },
    {
      name: 'need_clarification',
      description: 'Ask the user instead of guessing when missing information would change the output.',
      eager_input_streaming: true,
      input_schema: obj({ questions: { type: 'array', items: questionSchema } }),
    },
  ];
}

function generateSystem(PACK) {
  return [
    'You turn a captured section of a web page into a small, runnable front-end project.',
    '',
    'Follow the user decisions exactly:',
    '- Use the chosen framework, language and styling, with Vite. `npm install && npm run dev` must start it: include package.json (with a "dev" script and every dependency), index.html at the root, the Vite config and the entry files.',
    '- Handle images, fonts and icons as chosen (definitions below).',
    '- Answers to earlier questions are binding.',
    '- If a theme is supplied, its token file is the only source of colours, radius, shadow, spacing and fonts: copy it into the project (the CSS variables file, or the @theme block for Tailwind) and reference the tokens instead of raw values.',
    '',
    'Rebuild only what is in the capture, matching layout, spacing, colours, typography and text so it looks the same at the captured viewport width. Split it into a few sensible components.',
    'Do not add anything that was not requested: no extra pages, routing, state libraries, tests, analytics, backends, network calls or features. Add interaction only where the capture clearly shows it.',
    `If information you need is missing or ambiguous in a way that changes the output, call need_clarification instead of guessing: 1 to ${PACK.maxRequiredQuestions} questions, each with 2 to 6 concrete options, in the user locale. Never invent an answer.`,
    'Otherwise call emit_project once with every file.',
    '',
    'File rules: relative POSIX paths only, no "..", no absolute paths, text files only. Do not write node_modules, lockfiles, .env or anything under public/assets/ (the server adds bundled images there).',
    '',
    'Asset handling:',
    '- images bundle: use the local URL listed in bundledImages for each source URL; any image not listed becomes a placeholder.',
    '- images placeholder: a neutral box of the captured size using the surface colour, keeping the alt text.',
    '- images link: the original absolute URL.',
    '- fonts bundle: @fontsource packages for families hosted on Google Fonts, otherwise the system font stack.',
    '- fonts placeholder: the system font stack.',
    '- fonts link: a Google Fonts <link> for families hosted there, otherwise the system font stack.',
    '- icons bundle: local SVG components or files built from the captured path data.',
    '- icons placeholder: simple shapes of the same size and colour.',
    '- icons link: the captured path data inlined as-is; never load an icon CDN.',
  ].join('\n');
}

const REMIND_ANALYZE = 'Please answer by calling the report_analysis tool.';
const REMIND_GENERATE = 'Please answer by calling emit_project, or need_clarification if information is missing.';

module.exports = { analyzeTool, analyzeSystem, generateTools, generateSystem, REMIND_ANALYZE, REMIND_GENERATE };
