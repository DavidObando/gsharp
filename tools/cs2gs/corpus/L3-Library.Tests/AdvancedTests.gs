// xUnit coverage of the L3-Library public surface.

package Corpus.L3.Tests

import Corpus.L3
import System
import System.Collections.Generic
import System.Threading.Tasks
import Xunit

class GenericsTests {
    @Fact
    func Repository_Add_Index_Count_Contains() {
        let repo = Repository[string]()
        repo.Add("a")
        repo.Add("b")
        Assert.Equal(2, repo.Count)
        Assert.Equal("a", repo[0])
        Assert.True(repo.Contains("b"))
        Assert.False(repo.Contains("c"))
        Assert.Equal([]string{"a", "b"}, repo)
    }

    @Theory
    @InlineData([]int32{3, 1, 4, 1, 5}, int32(5))
    @InlineData([]int32{-2, -7, -1}, int32(-1))
    func Algorithms_Max(values[]int32, expected int32) {
        Assert.Equal(expected, Algorithms.Max(values))
    }

    @Fact
    func Algorithms_Ends_Infers_Type() {
        let (first, last) = Algorithms.Ends([]int32{10, 20, 30})
        Assert.Equal(10, first)
        Assert.Equal(30, last)
    }

    @Fact
    func Algorithms_OrDefault_Handles_Null() {
        Assert.Equal("fallback", Algorithms.OrDefault[string](nil, "fallback"))
        Assert.Equal("value", Algorithms.OrDefault("value", "fallback"))
    }

    @Fact
    func Algorithms_Max_Empty_Throws() {
        Assert.Throws[ArgumentException](
            func () object? {
                return Algorithms.Max(Array.Empty[int32]())
            }
        )
    }
}

class PatternTests {
    @Theory
    @MemberData("ShapeAreas")
    func Shapes_Area_SwitchExpression(shape Shape, expected float64) {
        Assert.Equal(expected, Shapes.Area(shape), 9)
    }

    @Theory
    @InlineData(1.0, "small")
    @InlineData(5.0, "medium")
    @InlineData(20.0, "large")
    func Shapes_Describe_RelationalPatterns(side float64, expected string) {
        Assert.Equal(expected, Shapes.Describe(Square(side)))
    }

    shared {
        func ShapeAreas() IEnumerable[[]object] -> List[[]object]{
            []object{Circle(2.0), Math.PI * 4.0},
            []object{Rectangle(3.0, 4.0), 12.0},
            []object{Square(5.0), 25.0}
        }
    }
}

class StatisticsTests {
    @Fact
    func SumOfSquaresOfEvens_LinqMethodSyntax() {
        Assert.Equal(20, Statistics.SumOfSquaresOfEvens([]int32{1, 2, 3, 4}))
    }

    @Fact
    func SortedDistinct_LinqQuerySyntax() {
        Assert.Equal([]int32{1, 2, 3}, Statistics.SortedDistinct([]int32{3, 1, 2, 3, 1}))
    }

    @Fact
    func Compose_Delegates() {
        let addOne = Statistics.Compose((x int32) -> x + 1, (x int32) -> x * 2)
        Assert.Equal(7, addOne(3))
    }

    @Fact
    func ForEachIndexed_Invokes_Action() {
        let seen = List[string]()
        Statistics.ForEachIndexed([]string{"a", "b"}, (i int32, s string) -> seen.Add("$i:$s"))
        Assert.Equal([]string{"0:a", "1:b"}, seen)
    }
}

class ExtensionTests {
    @Theory
    @InlineData("ab", int32(3), "ababab")
    @InlineData("x", int32(0), "")
    func Repeat_Extension(value string, times int32, expected string) {
        Assert.Equal(expected, value.Repeat(times))
    }

    @Fact
    func WordCount_Extension() {
        Assert.Equal(3, "the quick fox".WordCount())
    }
}

class AsyncTests {
    @Fact
    async func SumAsync_Awaits() {
        Assert.Equal(6, await AsyncWork.SumAsync([]int32{1, 2, 3}))
    }

    @Fact
    async func ProductAsync_Awaits() {
        Assert.Equal(24, await AsyncWork.ProductAsync([]int32{1, 2, 3, 4}))
    }
}
