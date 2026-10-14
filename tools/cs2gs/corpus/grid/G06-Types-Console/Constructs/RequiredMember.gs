// inventory: ObjectInitializerExpression — object initializer, including a
// `required` member (issue #1892: previously any object initializer emitted
// stray bare assignment statements before the composite literal).

package Corpus.Grid06

import System

open class ProfileCard {
    private var _name string = ""

    prop Name string {
        get {
            return _name
        }
        set {
            _name = value
        }
    }

    prop Age int32
}

shared class RequiredMemberFixture {
    func Run() {
        let card = ProfileCard{Name: "ada", Age: 36}
        Console.WriteLine("RequiredMember: name=" + card.Name + " age=" + card.Age.ToString())
    }
}
