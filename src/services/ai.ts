import type { Transaction } from '../hooks/useTransactions';

const OPENAI_API_KEY = import.meta.env.VITE_OPENAI_API_KEY;

export async function analyzeSpending(transactions: Transaction[]): Promise<string> {
  if (!OPENAI_API_KEY) {
    throw new Error("OpenAI API Key is missing. Please set VITE_OPENAI_API_KEY in your .env file.");
  }

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
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'HTTP-Referer': window.location.origin, // Recommended by OpenRouter
        'X-Title': 'Money Manager Local', // Recommended by OpenRouter
      },
      body: JSON.stringify({
        model: 'openai/gpt-4o-mini', // OpenRouter model ID
        messages: [
          { role: 'system', content: 'You are a helpful financial assistant.' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 200,
        temperature: 0.7
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error?.message || 'Failed to fetch analysis from OpenAI');
    }

    const data = await response.json();
    return data.choices[0]?.message?.content || "No analysis could be generated.";
  } catch (error) {
    console.error("AI Analysis Error:", error);
    throw error;
  }
}
