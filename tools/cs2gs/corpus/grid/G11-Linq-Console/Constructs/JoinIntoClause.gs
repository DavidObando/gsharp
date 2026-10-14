// inventory: JoinIntoClause (group join, lowers to GroupJoin, issue #1902)

package Corpus.Grid11

import System
import System.Linq

shared class JoinIntoClauseFixture {
    func Run() {
        let owners[](Id int32, Name string) = [](Id int32, Name string){(1, "ada"), (2, "bea"), (3, "cid")}
        let pets[](Name string, OwnerId int32) = [](Name string, OwnerId int32){("rex", 2), ("tom", 1), ("ziggy", 2)}
        // Group join.
        let counts = owners.GroupJoin(
            pets,
            (o(Id int32, Name string)) -> o.Id,
            (p(Name string, OwnerId int32)) -> p.OwnerId,
            (o(Id int32, Name string), petGroup sequence[(Name string, OwnerId int32)]) -> {
                return (o, petGroup)
            }
        )
            .Select(
            (
                (o(Id int32, Name string), petGroup sequence[(Name string, OwnerId int32)])
            ) -> "${o.Name}=${petGroup.Count()}"
        )
        Console.WriteLine("JoinIntoClause: counts=${string.Join(",", counts)}")
        let rosters = owners.GroupJoin(
            pets,
            (o(Id int32, Name string)) -> o.Id,
            (p(Name string, OwnerId int32)) -> p.OwnerId,
            (o(Id int32, Name string), petGroup sequence[(Name string, OwnerId int32)]) -> {
                return (o, petGroup)
            }
        )
            .Select(
            (
                (o(Id int32, Name string), petGroup sequence[(Name string, OwnerId int32)])
            ) -> "${o.Name}:[${string.Join("|", petGroup.Select((g (Name string, OwnerId int32)) -> g.Name))}]"
        )
        Console.WriteLine("JoinIntoClause: rosters=${string.Join(",", rosters)}")
    }
}
