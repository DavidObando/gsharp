// inventory: OrPattern

package Corpus.Grid04.Constructs

import System

shared class OrPatternFixture {
    func Run() {
        let codes[]int32 = []int32{200, 201, 204, 404, 500}
        for code in codes {
            let success = code == 200 || code == 201 || code == 204
            Console.WriteLine("OrPattern: status $code is success = $success")
        }
        let letters[]char = []char{'a', 'b', 'e', 'z'}
        for c in letters {
            let vowel = c == 'a' || c == 'e' || c == 'i' || c == 'o' || c == 'u'
            Console.WriteLine("OrPattern: '$c' is vowel = $vowel")
        }
        let outlier = 150
        let outOfRange = outlier < 0 || outlier > 100
        Console.WriteLine("OrPattern: 150 is < 0 or > 100 = $outOfRange")
    }
}
