// inventory: CasePatternSwitchLabel
using System;

namespace Corpus.Grid04.Constructs
{
    public static class CasePatternSwitchLabelFixture
    {
        public static void Run()
        {
            object?[] inputs = { 5, 42, "hello", null, 3.5 };
            foreach (object? item in inputs)
            {
                switch (item)
                {
                    case int n when n > 10:
                        Console.WriteLine($"CasePatternSwitchLabel: big int {n}");
                        break;
                    case int n:
                        Console.WriteLine($"CasePatternSwitchLabel: small int {n}");
                        break;
                    case string s:
                        Console.WriteLine($"CasePatternSwitchLabel: string of length {s.Length}");
                        break;
                    case null:
                        Console.WriteLine("CasePatternSwitchLabel: null input");
                        break;
                    default:
                        Console.WriteLine("CasePatternSwitchLabel: something else");
                        break;
                }
            }
        }
    }
}
