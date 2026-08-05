import React, { useState } from 'react';

const App: React.FC = () => {
  const [expression, setExpression] = useState('');
  const [result, setResult] = useState<string | null>(null);

  // Placeholder UI – actual calculator will be built later
  return (
    <div style={{ padding: '2rem', fontFamily: 'sans-serif' }}>
      <h1>Simple Calculator</h1>
      <div>
        <strong>Expression:</strong> {expression || <em>none</em>}
      </div>
      {result !== null && (
        <div>
          <strong>Result:</strong> {result}
        </div>
      )}
    </div>
  );
};

export default App;
