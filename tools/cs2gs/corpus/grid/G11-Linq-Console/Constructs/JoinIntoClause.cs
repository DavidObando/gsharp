// inventory: JoinIntoClause (group join, lowers to GroupJoin, issue #1902)
using System;
using System.Linq;

namespace Corpus.Grid11
{
    public static class JoinIntoClauseFixture
    {
        public static void Run()
        {
            (int Id, string Name)[] owners =
            {
                (1, "ada"),
                (2, "bea"),
                (3, "cid"),
            };
            (string Name, int OwnerId)[] pets =
            {
                ("rex", 2),
                ("tom", 1),
                ("ziggy", 2),
            };

            // Group join.
            var counts = from o in owners
                         join p in pets on o.Id equals p.OwnerId into petGroup
                         select $"{o.Name}={petGroup.Count()}";
            Console.WriteLine($"JoinIntoClause: counts={string.Join(",", counts)}");

            var rosters = from o in owners
                          join p in pets on o.Id equals p.OwnerId into petGroup
                          select $"{o.Name}:[{string.Join("|", from g in petGroup select g.Name)}]";
            Console.WriteLine($"JoinIntoClause: rosters={string.Join(",", rosters)}");
        }
    }
}
