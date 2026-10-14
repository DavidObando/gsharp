// inventory: PrimaryConstructorBaseType — primary constructor on plain class (C#12 probe) + derived : Base(arg)

package Corpus.Grid06

import System

open class NamedItem(name string) {
    func Name() string {
        return name
    }
}

open class PricedItem(name string, price int32) : NamedItem(name) {
    func Price() int32 {
        return price
    }
}

shared class PrimaryConstructorBaseTypeFixture {
    func Run() {
        let item = NamedItem("widget")
        Console.WriteLine("PrimaryConstructorBaseType: name=" + item.Name())
        let priced = PricedItem("gadget", 25)
        Console.WriteLine("PrimaryConstructorBaseType: derived=" + priced.Name() + "/" + priced.Price().ToString())
    }
}
