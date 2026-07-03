// inventory: ArrowExpressionClause — expression-bodied method, property, and constructor
using System;

namespace Corpus.Grid07
{
    public class ArrowBox
    {
        private readonly int _value;

        public ArrowBox(int value) => _value = value;

        public int Value => _value;

        public int Doubled() => _value * 2;

        public static int TripleOf(int input) => input * 3;
    }

    public static class ArrowExpressionClauseFixture
    {
        public static void Run()
        {
            ArrowBox box = new ArrowBox(21);
            Console.WriteLine("ArrowExpressionClause: value=" + box.Value.ToString());
            Console.WriteLine("ArrowExpressionClause: doubled=" + box.Doubled().ToString());
            Console.WriteLine("ArrowExpressionClause: tripled=" + ArrowBox.TripleOf(box.Value).ToString());
        }
    }
}
