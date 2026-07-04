// inventory: JoinClause (inner join, lowers to Join, issue #1902)
using System;
using System.Linq;

namespace Corpus.Grid11
{
    public sealed record Owner(int Id, string Name);

    public sealed record Pet(string Name, int OwnerId);

    public static class JoinClauseFixture
    {
        public static void Run()
        {
            Owner[] owners =
            {
                new Owner(1, "ada"),
                new Owner(2, "bea"),
                new Owner(3, "cid"),
            };
            Pet[] pets =
            {
                new Pet("rex", 2),
                new Pet("tom", 1),
                new Pet("ziggy", 2),
            };

            var matched = from o in owners
                          join p in pets on o.Id equals p.OwnerId
                          select $"{o.Name}+{p.Name}";
            Console.WriteLine($"JoinClause: matched={string.Join(",", matched)}");
        }
    }
}
