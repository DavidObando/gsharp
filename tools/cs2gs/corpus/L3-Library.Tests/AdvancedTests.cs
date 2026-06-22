// xUnit coverage of the L3-Library public surface.
using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Corpus.L3;
using Xunit;

namespace Corpus.L3.Tests
{
    public sealed class GenericsTests
    {
        [Fact]
        public void Repository_Add_Index_Count_Contains()
        {
            var repo = new Repository<string>();
            repo.Add("a");
            repo.Add("b");

            Assert.Equal(2, repo.Count);
            Assert.Equal("a", repo[0]);
            Assert.True(repo.Contains("b"));
            Assert.False(repo.Contains("c"));
            Assert.Equal(new[] { "a", "b" }, repo);
        }

        [Theory]
        [InlineData(new[] { 3, 1, 4, 1, 5 }, 5)]
        [InlineData(new[] { -2, -7, -1 }, -1)]
        public void Algorithms_Max(int[] values, int expected)
        {
            Assert.Equal(expected, Algorithms.Max(values));
        }

        [Fact]
        public void Algorithms_Ends_Infers_Type()
        {
            var (first, last) = Algorithms.Ends(new[] { 10, 20, 30 });
            Assert.Equal(10, first);
            Assert.Equal(30, last);
        }

        [Fact]
        public void Algorithms_OrDefault_Handles_Null()
        {
            Assert.Equal("fallback", Algorithms.OrDefault<string>(null, "fallback"));
            Assert.Equal("value", Algorithms.OrDefault("value", "fallback"));
        }

        [Fact]
        public void Algorithms_Max_Empty_Throws()
        {
            Assert.Throws<ArgumentException>(() => Algorithms.Max(Array.Empty<int>()));
        }
    }

    public sealed class PatternTests
    {
        public static IEnumerable<object[]> ShapeAreas() => new List<object[]>
        {
            new object[] { new Circle(2.0), Math.PI * 4.0 },
            new object[] { new Rectangle(3.0, 4.0), 12.0 },
            new object[] { new Square(5.0), 25.0 },
        };

        [Theory]
        [MemberData(nameof(ShapeAreas))]
        public void Shapes_Area_SwitchExpression(Shape shape, double expected)
        {
            Assert.Equal(expected, Shapes.Area(shape), 9);
        }

        [Theory]
        [InlineData(1.0, "small")]
        [InlineData(5.0, "medium")]
        [InlineData(20.0, "large")]
        public void Shapes_Describe_RelationalPatterns(double side, string expected)
        {
            Assert.Equal(expected, Shapes.Describe(new Square(side)));
        }
    }

    public sealed class StatisticsTests
    {
        [Fact]
        public void SumOfSquaresOfEvens_LinqMethodSyntax()
        {
            Assert.Equal(20, Statistics.SumOfSquaresOfEvens(new[] { 1, 2, 3, 4 }));
        }

        [Fact]
        public void SortedDistinct_LinqQuerySyntax()
        {
            Assert.Equal(new[] { 1, 2, 3 }, Statistics.SortedDistinct(new[] { 3, 1, 2, 3, 1 }));
        }

        [Fact]
        public void Compose_Delegates()
        {
            var addOne = Statistics.Compose(x => x + 1, x => x * 2);
            Assert.Equal(7, addOne(3));
        }

        [Fact]
        public void ForEachIndexed_Invokes_Action()
        {
            var seen = new List<string>();
            Statistics.ForEachIndexed(new[] { "a", "b" }, (i, s) => seen.Add($"{i}:{s}"));
            Assert.Equal(new[] { "0:a", "1:b" }, seen);
        }
    }

    public sealed class ExtensionTests
    {
        [Theory]
        [InlineData("ab", 3, "ababab")]
        [InlineData("x", 0, "")]
        public void Repeat_Extension(string value, int times, string expected)
        {
            Assert.Equal(expected, value.Repeat(times));
        }

        [Fact]
        public void WordCount_Extension()
        {
            Assert.Equal(3, "the quick fox".WordCount());
        }
    }

    public sealed class AsyncTests
    {
        [Fact]
        public async Task SumAsync_Awaits()
        {
            Assert.Equal(6, await AsyncWork.SumAsync(new[] { 1, 2, 3 }));
        }

        [Fact]
        public async Task ProductAsync_Awaits()
        {
            Assert.Equal(24, await AsyncWork.ProductAsync(new[] { 1, 2, 3, 4 }));
        }
    }
}
