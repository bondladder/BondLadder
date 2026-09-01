import { Link } from 'react-router-dom';

const NotFound = () => (
    <div className="max-w-[40rem]">
        <h1 className="mb-3 font-display text-[26px]">Page not found</h1>
        <p className="mb-6 border-b border-rule pb-6 text-[14px] leading-relaxed text-ink-muted">
            There is no such page in this register.
        </p>
        <Link
            to="/"
            className="border-b border-rule-strong pb-0.5 text-[13px] text-ink-muted transition-colors duration-200 hover:border-mark hover:text-ink"
        >
            Back to compose
        </Link>
    </div>
);

export default NotFound;
