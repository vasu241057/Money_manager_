import { useState, useEffect, useRef } from 'react';
import { Layout } from './components/Layout';
import { Dashboard } from './components/Dashboard';
import { TransactionList } from './components/TransactionList';
import { TransactionForm } from './components/TransactionForm';
import { CategoryManager } from './components/CategoryManager';
import { AccountManager } from './components/AccountManager';
import { AnalyticsModal } from './components/AnalyticsModal';
import { SplashScreen } from './components/SplashScreen';
import { useTransactions, type Transaction } from './hooks/useTransactions';
import { usePushReminders } from './hooks/usePushReminders';
import { DEFAULT_CATEGORIES } from './hooks/useCategories';
import { DEFAULT_ACCOUNTS } from './hooks/useAccounts';
import { Plus } from 'lucide-react';
import './styles/app.css';

type BackupPayload = {
  version: 1;
  exportedAt: string;
  data: {
    transactions: Transaction[];
    categories: unknown[];
    accounts: unknown[];
  };
};

function parseStoredArray(raw: string | null): unknown[] | null {
  if (raw === null) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function createBackupPayload(transactions: Transaction[]): BackupPayload {
  const categories = parseStoredArray(window.localStorage.getItem('categories')) ?? DEFAULT_CATEGORIES;
  const accounts = parseStoredArray(window.localStorage.getItem('accounts')) ?? DEFAULT_ACCOUNTS;

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    data: {
      transactions,
      categories,
      accounts,
    },
  };
}

function isLocalStateEmptyForImport() {
  const transactions = parseStoredArray(window.localStorage.getItem('transactions'));
  const categories = parseStoredArray(window.localStorage.getItem('categories'));
  const accounts = parseStoredArray(window.localStorage.getItem('accounts'));

  const hasTransactions = Boolean(transactions && transactions.length > 0);
  const hasCategories = Boolean(categories && categories.length > 0);
  const hasAccounts = Boolean(accounts && accounts.length > 0);

  return !(hasTransactions || hasCategories || hasAccounts);
}

function isValidBackupPayload(value: unknown): value is BackupPayload {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const payload = value as {
    version?: unknown;
    data?: {
      transactions?: unknown;
      categories?: unknown;
      accounts?: unknown;
    };
  };

  return (
    payload.version === 1 &&
    Array.isArray(payload.data?.transactions) &&
    Array.isArray(payload.data?.categories) &&
    Array.isArray(payload.data?.accounts)
  );
}

function MoneyManagerApp() {
  const { transactions, addTransaction, deleteTransaction } = useTransactions();
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isCategoryManagerOpen, setIsCategoryManagerOpen] = useState(false);
  const [isAccountManagerOpen, setIsAccountManagerOpen] = useState(false);
  const [isAnalyticsOpen, setIsAnalyticsOpen] = useState(false);
  const [isActionsOpen, setIsActionsOpen] = useState(false);
  const [editingTransaction, setEditingTransaction] = useState<Transaction | null>(null);
  const [viewMode, setViewMode] = useState<'daily' | 'monthly'>('daily');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const {
    isLoading: isReminderLoading,
    status: reminderStatus,
    enableReminders,
    disableReminders,
  } = usePushReminders();

  const handleReminderToggle = async () => {
    if (reminderStatus === 'enabled') {
      await disableReminders();
      return;
    }

    await enableReminders();
  };

  const handleExportJson = () => {
    try {
      const backupPayload = createBackupPayload(transactions);
      const blob = new Blob([JSON.stringify(backupPayload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `money-manager-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to export backup:', error);
      alert('Failed to export JSON backup.');
    }
  };

  const handleImportButtonClick = () => {
    fileInputRef.current?.click();
  };

  const handleImportFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      if (!isLocalStateEmptyForImport()) {
        alert('Import is allowed only when current app data is empty.');
        return;
      }

      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;

      if (!isValidBackupPayload(parsed)) {
        alert('Invalid backup file format.');
        return;
      }

      window.localStorage.setItem('transactions', JSON.stringify(parsed.data.transactions));
      window.localStorage.setItem('categories', JSON.stringify(parsed.data.categories));
      window.localStorage.setItem('accounts', JSON.stringify(parsed.data.accounts));
      window.location.reload();
    } catch (error) {
      console.error('Failed to import backup:', error);
      alert('Import failed. Please use a valid backup JSON file.');
    } finally {
      event.target.value = '';
    }
  };

  return (
    <Layout>
      <div className="header">
        <h2>My Wallet</h2>
        <div className="header-actions">
          <button
            className="settings-btn"
            onClick={() => {
              setIsActionsOpen((prev) => !prev);
            }}
          >
            {isActionsOpen ? 'Close' : 'Actions'}
          </button>
        </div>
      </div>
      {isActionsOpen && (
        <div className="actions-panel">
          <button
            className={`settings-btn ${reminderStatus === 'enabled' ? 'settings-btn-active' : ''}`}
            onClick={() => {
              void handleReminderToggle();
            }}
            disabled={isReminderLoading || reminderStatus === 'checking'}
          >
            {isReminderLoading
              ? 'Working...'
              : reminderStatus === 'enabled'
                ? 'Reminders On'
                : 'Reminders Off'}
          </button>
          <button className="settings-btn" onClick={handleExportJson}>
            Export JSON
          </button>
          <button className="settings-btn" onClick={handleImportButtonClick}>
            Import JSON
          </button>
          <button
            className="settings-btn"
            onClick={() => {
              setIsActionsOpen(false);
              setIsAccountManagerOpen(true);
            }}
          >
            Accounts
          </button>
          <button
            className="settings-btn"
            onClick={() => {
              setIsActionsOpen(false);
              setIsCategoryManagerOpen(true);
            }}
          >
            Categories
          </button>
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json"
        style={{ display: 'none' }}
        onChange={(event) => {
          void handleImportFile(event);
        }}
      />
      
      <Dashboard 
        transactions={transactions} 
        onBalanceClick={() => setIsAnalyticsOpen(true)}
      />
      
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

      {isAccountManagerOpen && (
        <AccountManager onClose={() => setIsAccountManagerOpen(false)} />
      )}

      {isAnalyticsOpen && (
        <AnalyticsModal 
          transactions={transactions} 
          onClose={() => setIsAnalyticsOpen(false)} 
        />
      )}
    </Layout>
  );
}

export default function App() {
  const [showSplash, setShowSplash] = useState(true);
  const [isAppReady, setIsAppReady] = useState(false);

  useEffect(() => {
    // Simulate app initialization/loading
    // In a real app, this might wait for data fetching, auth check, etc.
    // Since our hooks are synchronous (localStorage), we're technically ready immediately.
    // But we'll use a small timeout to ensure the render cycle is complete or simulate a check.
    const initApp = async () => {
      // Simulate some async work if needed, or just set ready
      setIsAppReady(true);
    };

    initApp();
  }, []);

  return (
    <>
      {showSplash && (
        <SplashScreen 
          isAppReady={isAppReady}
          minDuration={1000} // Configurable duration
          onFinish={() => setShowSplash(false)} 
        />
      )}
      <MoneyManagerApp />
    </>
  );
}
