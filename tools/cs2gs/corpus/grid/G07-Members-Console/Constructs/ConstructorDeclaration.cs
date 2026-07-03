// inventory: ConstructorDeclaration — overloaded constructors
using System;

namespace Corpus.Grid07
{
    public class Ticket
    {
        private readonly string _owner;
        private readonly int _seat;

        public Ticket()
        {
            _owner = "unassigned";
            _seat = 0;
        }

        public Ticket(string owner, int seat)
        {
            _owner = owner;
            _seat = seat;
        }

        public string Describe()
        {
            return _owner + "@" + _seat.ToString();
        }
    }

    public static class ConstructorDeclarationFixture
    {
        public static void Run()
        {
            Ticket blank = new Ticket();
            Ticket assigned = new Ticket("kim", 12);
            Console.WriteLine("ConstructorDeclaration: blank=" + blank.Describe());
            Console.WriteLine("ConstructorDeclaration: assigned=" + assigned.Describe());
        }
    }
}
