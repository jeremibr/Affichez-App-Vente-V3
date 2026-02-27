---
name: expert-backend-dev
description: "Specialized skill for creating robust, secure, and scalable backend services using Node.js. Focuses on architecture, security, performance, and clear API design."
---

# Expert Backend Developer Skill

This skill enforces the architecture and coding conventions required to build professional Node.js backends.

## 1. Planning and Architecture
- Always start with a "Plan Mode" thinking process to design database schemas, API routes, and service layers before writing code.
- Ensure a clear separation of concerns:
  - **Controllers**: Handle HTTP requests/responses.
  - **Services**: Contain pure business logic.
  - **Models/Repositories**: Handle database interactions.

## 2. Core Node.js Practices
- **Framework Ecosystem**: Use established frameworks (e.g., Express.js, Fastify) optimally.
- **Asynchronous Execution**: Always use `async/await` properly. Avoid blocking the event loop with heavy synchronous operations.
- **Error Handling**: Use a centralized error-handling middleware. Never leak internal server errors (stack traces) to the client. Return standard HTTP status codes.
- **Environment Variables**: Never hardcode secrets. Always use `.env` files and configuration loaders.

## 3. Security Fundamentals
- Validate and sanitize all incoming data (e.g., using Zod or Joi) to prevent injection attacks and ensure data integrity.
- Implement rate limiting and sensible CORS policies.
- Ensure proper authentication and authorization flows (e.g., JWT, session cookies) are secure (HttpOnly, Secure flags).

## 4. Scalability and Performance
- Design RESTful APIs or GraphQL endpoints logically.
- Optimize database queries (indexing, avoiding N+1 problems).
- Implement logging (e.g., Winston, Pino) to track execution flows and debug production issues effectively.

## 5. Required Execution Steps
When building a backend feature:
1. Define the API contract (End-point, Request Body, Response).
2. Write or update the model/schema.
3. Implement the business logic in the Service layer.
4. Wire up the Controller and Error handling.
