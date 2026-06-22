# Code Review Skill

**Description:** Provides code review best practices and checklist for reviewing code changes.

---

## Code Review Guidelines

When reviewing code or preparing to make changes, follow these practices:

### Review Checklist
1. **Correctness**: Does the code do what it's supposed to?
2. **Security**: Are there any obvious security vulnerabilities (injection, XSS, auth bypass)?
3. **Performance**: Are there obvious performance issues (N+1 queries, unnecessary loops)?
4. **Readability**: Is the code easy to understand? Are variable names descriptive?
5. **Error Handling**: Are errors handled gracefully? Are edge cases considered?
6. **Testing**: Are there tests covering the happy path and edge cases?
7. **Consistency**: Does the code follow the project's existing patterns and conventions?

### Review Approach
- Read the full diff before making comments
- Understand the context and purpose of the change
- Be specific: point to exact lines and explain why
- Suggest concrete improvements, not vague feedback
- Balance between "must fix" and "nice to have"

### When Making Changes
- Match the existing code style exactly
- Keep changes minimal — don't refactor unrelated code
- Add comments only when they explain non-obvious decisions
- Update or add tests for your changes
- Verify your changes don't break existing functionality
