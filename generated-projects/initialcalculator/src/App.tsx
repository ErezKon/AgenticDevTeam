import { useState } from 'react';
import './App.css';

function App() {
  const [count, setCount] = useState(0);

  return (
    <div className="App">
      <header className="App-header">
        <h1>Initial Calculator</h1>
        <p>Vite + React + TypeScript</p>
        <div className="card">
          <button onClick={() => setCount((c) => c + 1)}>
            count is {count}
          </button>
        </p>
      </header>
    </div>
  );
}

export default App;
