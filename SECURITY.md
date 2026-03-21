# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Tracalorie, please email us at security@tracalorie.dev instead of using the issue tracker.

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will acknowledge receipt of your report within 48 hours and provide an estimated timeline for a fix.

## Security Best Practices

### For Users

1. **Use Strong Passwords**
   - Use unique, complex passwords
   - Never share your credentials

2. **Keep Software Updated**
   - Update Node.js regularly
   - Keep dependencies current

3. **Secure Your Environment**
   - Use HTTPS in production
   - Keep your database secure
   - Use strong JWT secrets

### For Developers

1. **Environment Variables**
   - Never commit `.env` files
   - Use `.env.example` for templates
   - Rotate secrets regularly

2. **Dependencies**
   - Keep dependencies updated
   - Review security advisories
   - Use `npm audit` regularly

3. **Code Review**
   - Review all pull requests
   - Check for security issues
   - Validate user inputs

4. **Database Security**
   - Use parameterized queries (already implemented)
   - Implement proper access controls
   - Enable database encryption

5. **Authentication**
   - Use bcrypt for password hashing (already implemented)
   - Implement JWT with expiration (already implemented)
   - Add rate limiting for auth endpoints

## Known Security Considerations

- JWT tokens expire after 7 days
- Passwords are hashed with bcrypt (10 rounds)
- SQL injection is prevented with parameterized queries
- CORS is configured for development

## Future Security Improvements

- [ ] Add rate limiting middleware
- [ ] Implement refresh token rotation
- [ ] Add request validation schemas
- [ ] Implement CSRF protection
- [ ] Add security headers (Helmet.js)
- [ ] Implement audit logging
- [ ] Add two-factor authentication

## Compliance

This project follows security best practices for:
- OWASP Top 10
- Node.js Security Best Practices
- PostgreSQL Security Guidelines

## Support

For security questions or concerns, please contact us at security@tracalorie.dev
