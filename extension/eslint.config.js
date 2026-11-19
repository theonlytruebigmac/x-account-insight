import js from '@eslint/js';
import globals from 'globals';

export default [
    js.configs.recommended,
    {
        files: ['src/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                ...globals.browser,
                chrome: 'readonly',
                browser: 'readonly'
            }
        },
        rules: {
            // caughtErrors: 'none' matches ESLint 8's old default, which this
            // codebase relied on for plenty of intentionally-unused catch bindings.
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
            'no-console': 'off',
            'prefer-const': 'error',
            'no-var': 'error',
            eqeqeq: ['error', 'always'],
            curly: ['error', 'multi-line'],
            semi: ['error', 'always'],
            quotes: ['error', 'single', { avoidEscape: true }],
            indent: ['error', 4, { SwitchCase: 1 }],
            'comma-dangle': ['error', 'never'],
            'arrow-parens': ['error', 'as-needed'],
            'object-shorthand': ['error', 'always'],
            'no-multiple-empty-lines': ['error', { max: 1 }]
        }
    },
    {
        files: ['rollup.config.js', 'scripts/*.js', 'scripts/*.mjs'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: globals.node
        }
    },
    {
        ignores: ['dist/', 'node_modules/']
    }
];
