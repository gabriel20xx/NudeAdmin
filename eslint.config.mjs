import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    files: ['**/*.js','**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2022
      }
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-undef': 'error'
    }
  },
  {
    files: ['test/**/*.{js,mjs}'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.es2022,
        // Vitest globals
        describe: true, it: true, expect: true, beforeAll: true, afterAll: true, beforeEach: true, afterEach: true
      }
    },
    rules: {
      'no-console': 'off',
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='http'][callee.property.name='request']",
          message: 'Use httpClient.mjs helpers instead of http.request directly in tests.'
        }
      ]
    }
  }
];
