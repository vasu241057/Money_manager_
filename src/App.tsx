import { useState } from 'react';
import { Layout } from './components/Layout';
import { Dashboard } from './components/Dashboard';
import { TransactionList } from './components/TransactionList';
import { TransactionForm } from './components/TransactionForm';
import { CategoryManager } from './components/CategoryManager';
import { useTransactions, type Transaction } from './hooks/useTransactions';
import { Plus, LogOut } from 'lucide-react';
import './styles/app.css';

function MoneyManagerApp() {
  const { transactions, addTransaction, deleteTransaction } = useTransactions();
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isCategoryManagerOpen, setIsCategoryManagerOpen] = useState(false);
  const [editingTransaction, setEditingTransaction] = useState<Transaction | null>(null);
  const [viewMode, setViewMode] = useState<'daily' | 'monthly'>('daily');

  return (
    <Layout>
      <div className="header">
        <h2>My Wallet</h2>
        <div className="header-actions">
          <button className="settings-btn" onClick={() => setIsCategoryManagerOpen(true)}>
            Categories
          </button>
          <button className="settings-btn" onClick={() => {
            if (confirm('Are you sure you want to reset all data? This cannot be undone.')) {
              localStorage.clear();
              window.location.reload();
            }
          }}>
            <LogOut size={18} />
          </button>
        </div>
      </div>
      
      <Dashboard transactions={transactions} />
      
      <div className="section-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3>Transactions</h3>
        <div className="view-toggle">
          <button 
            className={`toggle-btn ${viewMode === 'daily' ? 'active' : ''}`}
            onClick={() => setViewMode('daily')}
          >
            Daily
          </button>
          <button 
            className={`toggle-btn ${viewMode === 'monthly' ? 'active' : ''}`}
            onClick={() => setViewMode('monthly')}
          >
            Monthly
          </button>
        </div>
      </div>
      
      <TransactionList 
        transactions={transactions} 
        onDelete={deleteTransaction} 
        onEdit={(t) => {
          setEditingTransaction(t);
          setIsFormOpen(true);
        }}
        viewMode={viewMode}
      />

      <button className="fab" onClick={() => {
        setEditingTransaction(null);
        setIsFormOpen(true);
      }}>
        <Plus size={24} />
      </button>

      {isFormOpen && (
        <TransactionForm 
          key={editingTransaction?.id ?? 'new'}
          initialData={editingTransaction}
          onSubmit={addTransaction} 
          onClose={() => {
            setIsFormOpen(false);
            setEditingTransaction(null);
          }} 
        />
      )}

      {isCategoryManagerOpen && (
        <CategoryManager onClose={() => setIsCategoryManagerOpen(false)} />
      )}
    </Layout>
  );
}

export default function App() {
  return <MoneyManagerApp />;
}
