// inventory: ObjectCreationExpression

package Corpus.Grid05

import System

class GridPoint {
    init() { }

    init(x int32, y int32) {
        X = x
        Y = y
    }

    prop X int32
    prop Y int32
}

shared class ObjectCreationExpressionFixture {
    func Run() {
        let byCtor = GridPoint(3, 4)
        Console.WriteLine("ObjectCreationExpression: byCtor=(${byCtor.X},${byCtor.Y})")
        // Issue #1892: a plain object initializer with no constructor args.
        let byInit = GridPoint{X: 1, Y: 2}
        Console.WriteLine("ObjectCreationExpression: byInit=(${byInit.X},${byInit.Y})")
        // Issue #1892: constructor args PLUS an object initializer.
        let byCtorAndInit = GridPoint(9, 0){Y = 8}
        Console.WriteLine("ObjectCreationExpression: byCtorAndInit=(${byCtorAndInit.X},${byCtorAndInit.Y})")
        // ImplicitObjectCreationExpression (target-typed new, no initializer).
        let implicitNew = GridPoint(7, 7)
        Console.WriteLine("ObjectCreationExpression: implicitNew=(${implicitNew.X},${implicitNew.Y})")
    }
}
