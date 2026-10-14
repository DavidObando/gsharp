// inventory: SimpleBaseType — base list mixing a base class and an interface

package Corpus.Grid06

import System

interface ITagged {
    func Tag() string;
}

open class Widget {
    open func Kind() string {
        return "widget"
    }
}

open class Sprocket : Widget, ITagged {
    open override func Kind() string {
        return "sprocket"
    }

    func Tag() string {
        return "tag-" + Kind()
    }
}

shared class SimpleBaseTypeFixture {
    func Run() {
        let sprocket = Sprocket()
        let asWidget Widget = sprocket
        let asTagged ITagged = sprocket
        Console.WriteLine("SimpleBaseType: kind=" + asWidget.Kind())
        Console.WriteLine("SimpleBaseType: tag=" + asTagged.Tag())
    }
}
