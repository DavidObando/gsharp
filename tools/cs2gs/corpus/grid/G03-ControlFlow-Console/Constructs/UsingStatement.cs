// inventory: UsingStatement
using System;

namespace Corpus.Grid03.Constructs
{
    internal sealed class TraceScope : IDisposable
    {
        private readonly string _name;

        public TraceScope(string name)
        {
            _name = name;
            Console.WriteLine($"UsingStatement: enter {_name}");
        }

        public void Dispose()
        {
            Console.WriteLine($"UsingStatement: dispose {_name}");
        }
    }

    public static class UsingStatementFixture
    {
        public static void Run()
        {
            using (var outer = new TraceScope("block-form"))
            {
                Console.WriteLine("UsingStatement: inside block form");
            }

            Console.WriteLine("UsingStatement: after block form");

            RunDeclarationForm();
            Console.WriteLine("UsingStatement: after declaration form");
        }

        private static void RunDeclarationForm()
        {
            using var scoped = new TraceScope("declaration-form");
            Console.WriteLine("UsingStatement: inside declaration form");
        }
    }
}
