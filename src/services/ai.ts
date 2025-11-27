import type { Transaction } from '../hooks/useTransactions';

export async function analyzeSpending(transactions: Transaction[]): Promise<string> {


  // Prepare a summary of transactions to send to the AI
  // We don't want to send too much data, so let's aggregate by category
  const expenses = transactions.filter(t => t.type === 'expense');
  const categoryMap = new Map<string, number>();
  
  expenses.forEach(t => {
    const current = categoryMap.get(t.category) || 0;
    categoryMap.set(t.category, current + t.amount);
  });

  const summary = Array.from(categoryMap.entries())
    .map(([category, amount]) => `- ${category}: ₹${amount.toFixed(2)}`)
    .join('\n');

  const totalExpense = expenses.reduce((acc, t) => acc + t.amount, 0);

  const prompt = `
    You are a financial advisor. Analyze the following spending summary for this month:
    
    Total Expense: ₹${totalExpense.toFixed(2)}
    
    Category Breakdown:
    ${summary}
    
    Please provide a brief, insightful analysis of the spending habits and 1-2 actionable tips to save money. Keep it friendly and concise (max 3-4 sentences).
  `;

  try {
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prompt })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || 'Failed to fetch analysis');
    }

    const data = await response.json();
    return data.choices[0]?.message?.content || "No analysis could be generated.";
  } catch (error) {
    console.error("AI Analysis Error:", error);
    throw error;
  }
}
