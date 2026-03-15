/**
 * Auth tests — signup (first run), login, logout, user management.
 *
 * The make test bootstrap POSTs to /signup before Cypress starts, creating
 * the admin user. These tests validate the UI flows from that point.
 */
describe('Authentication', () => {
  const USERNAME = Cypress.env('USERNAME');
  const PASSWORD = Cypress.env('PASSWORD');

  // ----------------------------------------------------------------
  // Login page
  // ----------------------------------------------------------------
  context('Login page', () => {
    it('shows the login form with username and password fields', () => {
      cy.visit('/login');
      cy.get('#username').should('be.visible');
      cy.get('#password').should('be.visible');
      cy.get('button[type="submit"]').should('be.visible').and('contain.text', 'Sign in');
    });

    it('shows an error for wrong credentials', () => {
      cy.visit('/login');
      cy.get('#username').type(USERNAME);
      cy.get('#password').type('wrongpassword!');
      cy.get('button[type="submit"]').click();
      cy.url().should('include', '/login');
      cy.get('.auth-alert-error').should('be.visible').and('contain.text', 'Invalid');
    });

    it('logs in with correct credentials and lands on dashboard', () => {
      cy.visit('/login');
      cy.get('#username').type(USERNAME);
      cy.get('#password').type(PASSWORD);
      cy.get('button[type="submit"]').click();
      cy.url().should('not.include', '/login');
      // Overview or workloads page
      cy.get('body').should('be.visible');
    });
  });

  // ----------------------------------------------------------------
  // Authenticated navigation
  // ----------------------------------------------------------------
  context('Authenticated session', () => {
    beforeEach(() => cy.loginUI());

    it('dashboard loads at /', () => {
      cy.visit('/');
      cy.url().should('not.include', '/login');
    });

    it('redirects to /login when not authenticated', () => {
      cy.clearCookies();
      cy.visit('/', { failOnStatusCode: false });
      cy.url().should('include', '/login');
    });

    it('logout button ends the session', () => {
      cy.visit('/');
      // Find the logout form/button — it's a POST form in the sidebar/topbar
      cy.get('form[action="/logout"] button, button[data-logout]').first().click();
      cy.url().should('include', '/login');
      // Navigating back to / should redirect to login
      cy.visit('/', { failOnStatusCode: false });
      cy.url().should('include', '/login');
    });
  });

  // ----------------------------------------------------------------
  // User management page
  // ----------------------------------------------------------------
  context('User management', () => {
    beforeEach(() => cy.loginUI());

    it('users page lists the admin user', () => {
      cy.visit('/users');
      cy.contains(USERNAME).should('be.visible');
    });

    it('can create a new user and see them in the list', () => {
      const tmpUser = 'cypress-tmp';
      const tmpPass = 'tmp-pass-1234';
      cy.visit('/users');
      // Fill in the add-user form
      cy.get('input[name="username"]').first().clear().type(tmpUser);
      cy.get('input[name="password"]').first().clear().type(tmpPass);
      cy.get('input[name="confirm"]').first().clear().type(tmpPass);
      cy.get('button[type="submit"]').first().click();
      cy.contains(tmpUser).should('be.visible');
    });

    it('can delete a non-self user', () => {
      // cypress-tmp should exist from previous test run; delete if present
      cy.visit('/users');
      cy.get('body').then(($body) => {
        if ($body.text().includes('cypress-tmp')) {
          cy.contains('tr', 'cypress-tmp').within(() => {
            cy.get('button[type="submit"]').last().click();
          });
          cy.on('window:confirm', () => true);
          cy.contains('cypress-tmp').should('not.exist');
        }
      });
    });
  });
});
