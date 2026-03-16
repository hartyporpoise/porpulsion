/**
 * Auth tests — login, logout, user management.
 * All interactions go through the browser UI.
 */
describe('Authentication', () => {
  const USERNAME = Cypress.env('USERNAME');
  const PASSWORD = Cypress.env('PASSWORD');

  context('Login page', () => {
    it('shows the login form', () => {
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
      cy.get('body').should('contain.text', 'Invalid');
    });

    it('logs in with correct credentials and lands on dashboard', () => {
      cy.visit('/login');
      cy.get('#username').type(USERNAME);
      cy.get('#password').type(PASSWORD);
      cy.get('button[type="submit"]').click();
      cy.url().should('not.include', '/login');
    });
  });

  context('Authenticated session', () => {
    beforeEach(() => cy.loginTo());

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
      // Open the user menu in the topbar, then click Sign out
      cy.get('#user-menu-btn').click();
      cy.get('form[action="/logout"] button[type="submit"]').click();
      cy.url().should('include', '/login');
      // Navigating back should still redirect to login
      cy.visit('/', { failOnStatusCode: false });
      cy.url().should('include', '/login');
    });
  });

  context('User management', () => {
    beforeEach(() => cy.loginTo());

    it('users page lists the admin user', () => {
      cy.visit('/users');
      cy.contains(USERNAME).should('be.visible');
    });

    it('can create a new user and see them in the list', () => {
      const tmpUser = 'cypress-tmp';
      const tmpPass = 'Tmp-pass-1234!';
      cy.visit('/users');
      cy.get('#new-username').clear().type(tmpUser);
      cy.get('#new-password').clear().type(tmpPass);
      cy.get('#new-confirm').clear().type(tmpPass);
      cy.get('form[action="/users/add"] button[type="submit"]').click();
      cy.contains(tmpUser).should('be.visible');
    });

    it('can delete a non-self user', () => {
      cy.visit('/users');
      cy.get('body').then(($body) => {
        if (!$body.text().includes('cypress-tmp')) return;
        cy.contains('.user-list-row', 'cypress-tmp').find('button.btn-icon-danger').click();
        cy.confirmDialog();
        cy.contains('cypress-tmp').should('not.exist');
      });
    });
  });
});
