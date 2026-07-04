// inventory: DelegateDeclaration — named delegate type with params+return,
// a void-returning delegate, method-group/lambda assignment, explicit .Invoke()
// (probe)
using System;

namespace Corpus.Grid09
{
    public delegate int Combine(int a, int b);

    public delegate void Note(string message);

    public static class DelegateDeclarationFixture
    {
        public static void Run()
        {
            Combine add = Add;
            Combine mul = (a, b) => a * b;
            Console.WriteLine($"DelegateDeclaration: add={add(2, 3)} mul={mul(2, 3)}");
            Console.WriteLine($"DelegateDeclaration: explicitInvoke={add.Invoke(4, 5)}");

            Note note = First;
            note("multicast");
        }

        private static int Add(int a, int b)
        {
            return a + b;
        }

        private static void First(string message)
        {
            Console.WriteLine($"DelegateDeclaration: first {message}");
        }
    }
}
