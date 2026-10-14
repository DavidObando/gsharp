// inventory: JoinClause (inner join, lowers to Join, issue #1902)

package Corpus.Grid11

import System
import System.Linq

data class Owner(Id int32, Name string) : IEquatable[Owner] { }

data class Pet(Name string, OwnerId int32) : IEquatable[Pet] { }

shared class JoinClauseFixture {
    func Run() {
        let owners[]Owner = []Owner{Owner(1, "ada"), Owner(2, "bea"), Owner(3, "cid")}
        let pets[]Pet = []Pet{Pet("rex", 2), Pet("tom", 1), Pet("ziggy", 2)}
        let matched = owners.Join(
            pets,
            (o Owner) -> o.Id,
            (p Pet) -> p.OwnerId,
            (o Owner, p Pet) -> {
                return (o, p)
            }
        )
            .Select(((o Owner, p Pet)) -> "${o.Name}+${p.Name}")
        Console.WriteLine("JoinClause: matched=${string.Join(",", matched)}")
    }
}
