import React from 'react';
import Calculator from './Calculator';

const App: React.FC = () => {
  return (
    <div className="app-container" style={{ padding: '1rem', maxWidth: '400px', margin: '0 auto' }}>
      <h1>Simple Calculator</h1>
      <Calculator />
    </div>
  );
};

export default App;
