import { Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import Compose from './pages/Compose';
import Statement from './pages/Statement';
import Redemption from './pages/Redemption';
import Register from './pages/Register';
import NotFound from './pages/NotFound';

const App = () => (
    <Routes>
        <Route element={<Layout />}>
            <Route path="/" element={<Compose />} />
            <Route path="/position" element={<Statement />} />
            <Route path="/exit" element={<Redemption />} />
            <Route path="/history" element={<Register />} />
            <Route path="*" element={<NotFound />} />
        </Route>
    </Routes>
);

export default App;
