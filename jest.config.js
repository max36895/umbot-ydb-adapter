module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/tests'],
    collectCoverageFrom: ['src/**/*.ts'],
    transform: {
        '^.+\.tsx?$': 'ts-jest',
    },
    testRegex: '(/__tests__/.*|(\.|/)(test))\.tsx?$',
    moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
};
