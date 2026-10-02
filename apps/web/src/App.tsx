import { Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import Compose from './pages/Compose';
import Exit from './pages/Exit';
import NotFound from './pages/NotFound';
import Register from './pages/Register';
import Statement from './pages/Statement';

const App = () => (
    <Routes>
        <Route element={<Layout />}>
            <Route path="/" element={<Compose />} />
            <Route path="/position" element={<Statement />} />
            <Route path="/exit" element={<Exit />} />
            <Route path="/history" element={<Register />} />
            <Route path="*" element={<NotFound />} />
        </Route>
    </Routes>
);

export default App;
