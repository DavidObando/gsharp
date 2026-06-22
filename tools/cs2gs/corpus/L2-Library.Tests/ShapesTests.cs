// xUnit coverage of the L2-Library public surface.
using Corpus.L2;
using Xunit;

namespace Corpus.L2.Tests
{
    public sealed class ShapesTests
    {
        [Fact]
        public void Circle_Area_And_Perimeter()
        {
            var circle = new Circle(2.0);
            Assert.Equal(ShapeKind.Circle, circle.Kind);
            Assert.Equal(12.566370614359172, circle.Area(), 9);
            Assert.Equal(12.566370614359172, circle.Perimeter(), 9);
        }

        [Theory]
        [InlineData(3.0, 4.0, 12.0)]
        [InlineData(2.5, 2.0, 5.0)]
        [InlineData(0.0, 9.0, 0.0)]
        public void Rectangle_Area_From_Dimensions(double width, double height, double expectedArea)
        {
            var rectangle = new Rectangle(new Dimensions(width, height));
            Assert.Equal(ShapeKind.Rectangle, rectangle.Kind);
            Assert.Equal(expectedArea, rectangle.Area());
        }

        [Fact]
        public void Point_DistanceTo_Is_Euclidean()
        {
            var a = new Point(0.0, 0.0);
            var b = new Point(3.0, 4.0);
            Assert.Equal(5.0, a.DistanceTo(b));
        }

        [Fact]
        public void RecordStruct_Has_Structural_Equality()
        {
            Assert.Equal(new Point(1.0, 2.0), new Point(1.0, 2.0));
            Assert.NotEqual(new Point(1.0, 2.0), new Point(2.0, 1.0));
        }

        [Fact]
        public void Record_Has_Structural_Equality_And_With()
        {
            var red = new NamedColor("red", 0xFF0000);
            var alsoRed = red with { };
            Assert.Equal(red, alsoRed);

            var green = red with { Name = "green", Rgb = 0x00FF00 };
            Assert.NotEqual(red, green);
            Assert.Equal("green", green.Name);
        }

        [Fact]
        public void Dimensions_Init_Properties()
        {
            var dims = new Dimensions { Width = 6.0, Height = 7.0 };
            Assert.Equal(42.0, dims.Width * dims.Height);
        }

        [Fact]
        public void Geometry_TotalArea_Overloads()
        {
            var c = new Circle(1.0);
            var r = new Rectangle(new Dimensions(2.0, 3.0));
            var t = new Circle(0.0);

            double two = Geometry.TotalArea(c, r);
            double three = Geometry.TotalArea(c, r, t);
            Assert.Equal(two, three);
            Assert.Equal(6.0 + System.Math.PI, three, 9);
        }

        [Theory]
        [InlineData(1.2345, 1.23)]
        [InlineData(1.2355, 1.24)]
        [InlineData(2.5, 2.5)]
        public void Geometry_Round_Default_Digits(double value, double expected)
        {
            Assert.Equal(expected, Geometry.Round(value));
        }

        [Theory]
        [InlineData(1.234, 123)]
        [InlineData(9.99, 999)]
        public void Geometry_ToCents_Rounds_Half_Up(double dollars, int expectedCents)
        {
            Assert.Equal(expectedCents, Geometry.ToCents(dollars));
        }
    }
}
