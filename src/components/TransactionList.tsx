import { useState } from 'react';
import { Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import '../styles/transaction-list.css';
import type { Transaction } from '../hooks/useTransactions';

interface TransactionListProps {
  transactions: Transaction[];
  onDelete: (id: string) => void;
  onEdit: (transaction: Transaction) => void;
  viewMode?: 'daily' | 'monthly';
}

export function TransactionList({ transactions, onDelete, onEdit, viewMode = 'daily' }: TransactionListProps) {
  const [expandedMonths, setExpandedMonths] = useState<Set<string>>(new Set());

  const toggleMonth = (key: string) => {
    const newExpanded = new Set(expandedMonths);
    if (newExpanded.has(key)) {
      newExpanded.delete(key);
    } else {
      newExpanded.add(key);
    }
    setExpandedMonths(newExpanded);
  };
  // Group transactions
  const grouped = transactions.reduce((acc, transaction) => {
    const date = new Date(transaction.date);
    let key: string;
    
    if (viewMode === 'monthly') {
      key = date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    } else {
      // Use date string for daily grouping
      key = date.toISOString().split('T')[0];
    }

    if (!acc[key]) acc[key] = [];
    acc[key].push(transaction);
    return acc;
  }, {} as Record<string, Transaction[]>);

  const sortedKeys = Object.keys(grouped).sort((a, b) => {
    return new Date(b).getTime() - new Date(a).getTime();
  });

  const formatHeader = (key: string) => {
    if (viewMode === 'monthly') return key;
    
    // const date = new Date(key);
    // Adjust for timezone if needed, but key is YYYY-MM-DD so local date parsing might be off if not careful.
    // Actually, new Date('YYYY-MM-DD') is UTC. new Date(YYYY, MM, DD) is local.
    // Let's treat the key as local date components to avoid timezone shifts.
    const [y, m, d] = key.split('-').map(Number);
    const localDate = new Date(y, m - 1, d);

    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (localDate.toDateString() === today.toDateString()) return 'Today';
    if (localDate.toDateString() === yesterday.toDateString()) return 'Yesterday';
    
    return localDate.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' });
  };

  const getGroupTotal = (groupTransactions: Transaction[]) => {
    return groupTransactions.reduce((acc, t) => {
      return t.type === 'expense' ? acc - t.amount : acc + t.amount;
    }, 0);
  };

  return (
    <div className="transaction-list">
      {sortedKeys.map(key => {
        const isExpanded = expandedMonths.has(key);
        const isMonthly = viewMode === 'monthly';
        const monthInitial = isMonthly ? formatHeader(key).charAt(0) : '';
        
        return (
          <div key={key} className="date-group">
            {isMonthly ? (
              <div 
                className="month-card"
                onClick={() => toggleMonth(key)}
              >
                <div className="chevron-icon">
                  {isExpanded ? <ChevronDown size={20} /> : <ChevronRight size={20} />}
                </div>
                <div className="month-icon">
                  {monthInitial}
                </div>
                <div className="month-details">
                  <div className="month-name">{formatHeader(key)}</div>
                  <div className="month-info">
                    {grouped[key].length} transaction{grouped[key].length !== 1 ? 's' : ''}
                  </div>
                </div>
                <span className={`month-total ${getGroupTotal(grouped[key]) < 0 ? 'expense' : 'income'}`}>
                  {getGroupTotal(grouped[key]) < 0 ? '-' : '+'}₹{Math.abs(getGroupTotal(grouped[key])).toFixed(2)}
                </span>
              </div>
            ) : (
              <div className="group-header">
                <h3 className="date-header">{formatHeader(key)}</h3>
                <span className={`day-total ${getGroupTotal(grouped[key]) < 0 ? 'expense' : 'income'}`}>
                  {getGroupTotal(grouped[key]) < 0 ? '-' : '+'}₹{Math.abs(getGroupTotal(grouped[key])).toFixed(2)}
                </span>
              </div>
            )}
            {(!isMonthly || isExpanded) && (
              <div className="transactions">
                {grouped[key].map(t => (
                  <div 
                    key={t.id} 
                    className="transaction-item"
                    onClick={() => onEdit(t)}
                  >
                    <div className="t-icon">
                      {t.category[0]}
                    </div>
                    <div className="t-details">
                      <div className="t-main">
                        <div className="t-cat-group">
                          <span className="t-category">{t.category}</span>
                          {t.subCategory && <span className="t-subcategory"> / {t.subCategory}</span>}
                        </div>
                        <span className={`t-amount ${t.type}`}>
                          {t.type === 'expense' ? '-' : '+'}
                          ₹{t.amount.toFixed(2)}
                        </span>
                      </div>
                      <div className="t-sub">
                        <span className="t-account">{t.accountId || 'Cash'}</span>
                        {t.description && <span className="t-note"> • {t.description}</span>}
                        {viewMode === 'monthly' && (
                          <span className="t-date"> • {new Date(t.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                        )}
                      </div>
                    </div>
                    <button 
                      className="delete-btn" 
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(t.id);
                      }}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
      
      {transactions.length === 0 && (
        <div className="empty-state">
          <p>No transactions yet.</p>
        </div>
      )}
    </div>
  );
}
