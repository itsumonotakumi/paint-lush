import tseslint from 'typescript-eslint';

const forbiddenSyntax = [
  { selector: "CallExpression[callee.name='eval']", message: 'eval is forbidden.' },
  { selector: "NewExpression[callee.name='Function']", message: 'new Function is forbidden.' },
  { selector: "AssignmentExpression[left.property.name='innerHTML']", message: 'Use textContent.' },
  { selector: "AssignmentExpression[left.property.name='outerHTML']", message: 'Use textContent.' },
  { selector: "CallExpression[callee.property.name='insertAdjacentHTML']", message: 'Use DOM APIs.' },
  { selector: "CallExpression[callee.property.name='postMessage']", message: 'postMessage is forbidden.' },
  { selector: "CallExpression[callee.name='fetch']", message: 'No network access.' },
];

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': 'error',
      'no-console': 'error',
      'no-restricted-syntax': ['error', ...forbiddenSyntax],
    },
  },
  {
    files: ['src/core/**/*.ts', 'src/game/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['three', 'three/*', '**/engine/*', '**/ui/*'], message: 'core and game stay headless.' }] },
      ],
      'no-restricted-globals': ['error', 'window', 'document', 'navigator', 'localStorage', 'location'],
      'no-restricted-syntax': [
        'error',
        ...forbiddenSyntax,
        { selector: "MemberExpression[object.name='Math'][property.name='random']", message: 'Use the seeded Rng.' },
        { selector: "MemberExpression[object.name='Date'][property.name='now']", message: 'Simulation must be deterministic.' },
      ],
    },
  },
);
