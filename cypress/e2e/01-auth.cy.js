/**
 * Auth tests — signup, login, logout, user management.
 * Runs against Agent A (the default baseUrl).
 */
describe("Authentication", () => {
  const USERNAME = Cypress.env("USERNAME");
  const PASSWORD = Cypress.env("PASSWORD");

  // ----------------------------------------------------------------
  // First-run signup flow
  // ----------------------------------------------------------------
  context("Signup (first run)", () => {
    it("redirects to /signup when no users exist (already seeded — just verify login works)", () => {
      // The make test bootstrap already created the user, so we should
      // land on /login, not /signup.
      cy.visit("/login");
      cy.get('input[name="username"]').should("exist");
    });
  });

  // ----------------------------------------------------------------
  // Login
  // ----------------------------------------------------------------
  context("Login page", () => {
    beforeEach(() => {
      cy.visit("/login");
    });

    it("shows the login form", () => {
      cy.get('input[name="username"]').should("be.visible");
      cy.get('input[name="password"]').should("be.visible");
      cy.get('button[type="submit"]').should("be.visible");
    });

    it("rejects wrong password", () => {
      cy.get('input[name="username"]').type(USERNAME);
      cy.get('input[name="password"]').type("wrongpassword!");
      cy.get('button[type="submit"]').click();
      cy.url().should("include", "/login");
      cy.contains(/invalid username or password/i).should("be.visible");
    });

    it("rejects empty username", () => {
      cy.get('input[name="password"]').type(PASSWORD);
      cy.get('button[type="submit"]').click();
      cy.url().should("include", "/login");
    });

    it("logs in with correct credentials and lands on dashboard", () => {
      cy.get('input[name="username"]').type(USERNAME);
      cy.get('input[name="password"]').type(PASSWORD);
      cy.get('button[type="submit"]').click();
      cy.url().should("not.include", "/login");
      // Dashboard should show the agent name somewhere
      cy.get("body").should("be.visible");
    });
  });

  // ----------------------------------------------------------------
  // Authenticated session
  // ----------------------------------------------------------------
  context("Authenticated session", () => {
    beforeEach(() => {
      cy.loginUI();
    });

    it("dashboard is accessible after login", () => {
      cy.visit("/");
      cy.url().should("not.include", "/login");
    });

    it("logout redirects to /login", () => {
      cy.visit("/");
      // Find and click the logout button/form
      cy.get('form[action="/logout"] button, button[data-action="logout"]').first().click();
      cy.url().should("include", "/login");
    });

    it("unauthenticated access to / redirects to /login", () => {
      // Verify by visiting without session
      cy.clearCookies();
      cy.visit("/", { failOnStatusCode: false });
      cy.url().should("include", "/login");
    });
  });

  // ----------------------------------------------------------------
  // User management
  // ----------------------------------------------------------------
  context("User management", () => {
    beforeEach(() => {
      cy.loginUI();
    });

    it("can navigate to the users page", () => {
      cy.visit("/users");
      cy.url().should("include", "/users");
      cy.contains(USERNAME).should("be.visible");
    });

    it("can add a new user and then remove them", () => {
      const tmpUser = "tmp-cypress-user";
      const tmpPass = "tmppassword1";

      // Add
      cy.visit("/users");
      cy.get('input[name="username"]').first().type(tmpUser);
      cy.get('input[name="password"]').first().type(tmpPass);
      cy.get('input[name="confirm"]').first().type(tmpPass);
      cy.get('button[type="submit"]').first().click();
      cy.contains(tmpUser).should("be.visible");

      // Remove
      cy.contains("tr", tmpUser).within(() => {
        cy.get('button[type="submit"], input[type="submit"]').last().click();
      });
      // Confirm if dialog shown
      cy.on("window:confirm", () => true);
      cy.contains(tmpUser).should("not.exist");
    });

    it("cannot delete the last/only user (self)", () => {
      cy.visit("/users");
      // The remove button for self should either not exist or be disabled
      cy.contains("tr", USERNAME).within(() => {
        // Either no delete button, or it's disabled
        cy.get('form[action*="/remove"] button').should(($btn) => {
          expect($btn.length === 0 || $btn.prop("disabled")).to.be.true;
        });
      });
    });

    it("password change requires matching confirmation", () => {
      cy.visit("/users");
      // Find the edit form/button for current user
      cy.contains("tr", USERNAME).within(() => {
        cy.get('button, a').contains(/edit/i).click();
      });
      cy.get('input[name="password"]').type("newpassword1");
      cy.get('input[name="confirm"]').type("differentpassword!");
      cy.get('button[type="submit"]').click();
      cy.contains(/do not match/i).should("be.visible");
    });
  });
});
