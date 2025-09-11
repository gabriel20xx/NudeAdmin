module.exports = {
  root: true,
  env: { node: true, es2022: true },
  extends: [ 'eslint:recommended' ],
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  plugins: [],
  rules: {
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    'no-undef': 'error'
  },
  overrides: [
    {
      files: ['test/**/*.{js,mjs}'],
      env: { node: true, es2022: true, 'vitest/globals': true },
      plugins: ['vitest'],
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
  ]
};
