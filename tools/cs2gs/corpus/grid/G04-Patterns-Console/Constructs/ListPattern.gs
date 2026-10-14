// inventory: ListPattern, SlicePattern

package Corpus.Grid04.Constructs

import System

shared class ListPatternFixture {
    func Run() {
        let exact[]int32 = []int32{1, 2, 3, 4}
        if exact.Length == 4 && exact[0] == 1 && exact[1] == 2 && exact[2] == 3 && exact[3] == 4 {
            Console.WriteLine("ListPattern: exact length match")
        }
        let edges[]int32 = []int32{1, 9, 9, 4}
        if edges.Length >= 2 && edges[0] == 1 && edges[edges.Length - 1] == 4 {
            Console.WriteLine("ListPattern: edge slice match")
        }
        let empty[]int32 = []int32{}
        if empty.Length == 0 {
            Console.WriteLine("ListPattern: empty match")
        }
        let headRest[]int32 = []int32{10, 20, 30}
        if headRest is [var head, .. rest] {
            Console.WriteLine("ListPattern: head=$head restLength=${rest.Length}")
        }
        let switchEdges[]int32 = []int32{1, 2, 3, 4}
        let classifyEdges = switch switchEdges {
            case []: "empty"
            case [1, .., 4]: "edges"
            case [var only]: "single:$only"
            default: "other"
        }
        Console.WriteLine("ListPattern: switch($classifyEdges) = edges expected")
        let switchEmpty[]int32 = []int32{}
        let classifyEmpty = switch switchEmpty {
            case []: "empty"
            case [1, .., 4]: "edges"
            case [var only]: "single:$only"
            default: "other"
        }
        Console.WriteLine("ListPattern: switch($classifyEmpty) = empty expected")
        let switchSingle[]int32 = []int32{7}
        let classifySingle = switch switchSingle {
            case []: "empty"
            case [1, .., 4]: "edges"
            case [var only]: "single:$only"
            default: "other"
        }
        Console.WriteLine("ListPattern: switch($classifySingle) = single expected")
    }
}
