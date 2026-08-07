describe('Landing page', () => {
  it('should load the app', () => {
    cy.visit('/')
    // Assuming the app has a title element with text Battleship
    cy.title().should('include', 'Battleship')
  })
})
