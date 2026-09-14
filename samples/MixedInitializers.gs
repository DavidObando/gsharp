import System
import System.Collections.Generic

class Node {
    public var Name string = ""
    public let Children List[Node] = List[Node]()

    init(name string) {
        Name = name
    }

    func Add(child Node) {
        Children.Add(child)
    }
}

let rows = []Node{Node("row")}
let root = Node("root"){.Name: "account", Node("title"){Node("label"),}, ...rows,}
Console.WriteLine(root.Name)
Console.WriteLine(root.Children.Count)
Console.WriteLine(root.Children[0].Children[0].Name)

let Capacity = "key"
let values = SortedList[string, int32](){Capacity: 7, .Capacity: 10,}
Console.WriteLine(values[Capacity])
Console.WriteLine(values.Capacity)
