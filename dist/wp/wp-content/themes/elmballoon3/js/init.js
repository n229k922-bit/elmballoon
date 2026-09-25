$(function () {
  var spFlag = false;
  var tn101 = "090";
  var tn102 = "8620";
  var tn103 = "0905";
  var spmenuFlag = false;
  var spmenuOpenFlag = false;
  var scrollpos;

  //ローディング処理
  $("#fade").append('<div id="load_gif"></div>');
  window.addEventListener("load", function () {
    $("html,body").animate(
      {
        scrollTop: 0,
      },
      "1"
    );
    slider_set();
    page_top();
    accordion();
    //電話番号
    $(".tel_num").text(tn101 + "-" + tn102 + "-" + tn103);
    //フェードイン
    $("#load_gif")
      .stop()
      .delay(200)
      .animate(
        {
          opacity: 0,
        },
        {
          duration: 600,
          complete: function () {
            $("#fade")
              .stop()
              .animate(
                {
                  opacity: 0,
                },
                {
                  duration: 600,
                  complete: function () {
                    $("#fade").remove();
                  },
                }
              );
          },
        }
      );

    // チェックボックスで表示を切り替える
    var receive_openFlag = 0;
    var receipt_openFlag = 0;

    $(
      '.receive .wpcf7-exclusive-checkbox .wpcf7-list-item:nth-child(1) label input[name="receive"]'
    ).change(function () {
      if (receive_openFlag === 2 || receive_openFlag === 3) {
        receive_openFlag = 1;
        checkedreceive();
      } else if (receive_openFlag === 0) {
        receive_openFlag = 1;
      } else if (receive_openFlag === 1) {
        receive_openFlag = 0;
      }
    });

    $(
      '.receive .wpcf7-exclusive-checkbox .wpcf7-list-item:nth-child(2) label input[name="receive"]'
    ).change(function () {
      if (receive_openFlag === 0 || receive_openFlag === 1) {
        receive_openFlag = 2;
        checkedreceive();
      } else if (receive_openFlag === 3) {
        receive_openFlag = 2;
      } else if (receive_openFlag === 2) {
        receive_openFlag = 0;
        checkedreceive();
      }
    });

    $(
      '.receive .wpcf7-exclusive-checkbox .wpcf7-list-item:nth-child(3) label input[name="receive"]'
    ).change(function () {
      if (receive_openFlag === 0 || receive_openFlag === 1) {
        receive_openFlag = 3;
        checkedreceive();
      } else if (receive_openFlag === 2) {
        receive_openFlag = 3;
      } else if (receive_openFlag === 3) {
        receive_openFlag = 0;
        checkedreceive();
      }
    });

    function checkedreceive() {
      $(".delivery").slideToggle(400);
    }

    $(
      '.receipt .wpcf7-exclusive-checkbox .wpcf7-list-item:nth-child(1) label input[name="receipt"]'
    ).change(function () {
      if (receipt_openFlag === 0 || receipt_openFlag === 2) {
        receipt_openFlag = 1;
        checkedreceipt();
      } else if (receipt_openFlag === 1) {
        receipt_openFlag = 0;
        checkedreceipt();
      }
    });

    $(
      '.receipt .wpcf7-exclusive-checkbox .wpcf7-list-item:nth-child(2) label input[name="receipt"]'
    ).change(function () {
      if (receipt_openFlag === 0) {
        receipt_openFlag = 2;
      } else if (receipt_openFlag === 1) {
        receipt_openFlag = 2;
        checkedreceipt();
      } else if (receipt_openFlag === 2) {
        receipt_openFlag = 0;
      }
    });

    function checkedreceipt() {
      $(".receipt_box").slideToggle(400);
    }
  });

  //header上のお知らせの高さを取得してfvを整える
  $(window).on("load resize", function () {
    var notice_height = $(".notice_area").innerHeight();
    var header_height = $("header").height();
    if (window.matchMedia("(max-width:800px)").matches) {
      $("header").css("top", notice_height + "px");
      $("#top_first_view").css({
        height: "100%",
        "margin-top": "calc(" + notice_height + "px + " + header_height + "px)",
      });
      $(".first_view").css(
        "margin-top",
        "calc(" + notice_height + "px + " + header_height + "px)"
      );
      $("#menu_fade").css(
        "top",
        "calc(" + notice_height + "px + " + header_height + "px)"
      );
    } else {
      $("header").css("top", notice_height + "px");
      $("#top_first_view").css({
        height:
          "calc(100vh - " + notice_height + "px - " + header_height + "px)",
        "margin-top": "calc(" + notice_height + "px + " + header_height + "px)",
      });
      $(".first_view").css(
        "margin-top",
        "calc(" + notice_height + "px + " + header_height + "px)"
      );
    }
  });

  //スマホFlag取得
  if (
    navigator.userAgent.indexOf("iPhone") > 0 ||
    navigator.userAgent.indexOf("iPod") > 0 ||
    (navigator.userAgent.indexOf("Android") > 0 &&
      navigator.userAgent.indexOf("Mobile") > 0) ||
    navigator.userAgent.indexOf("BlackBerry") > 0 ||
    navigator.userAgent.indexOf("IEMobile") > 0
  ) {
    spFlag = true;
  }

  /*----------------------
     page_top
    ------------------------*/
  function page_top() {
    var appear = false;
    var pagetop = $(".top_back");
    $(window).scroll(function () {
      if ($(this).scrollTop() > 100) {
        //100pxスクロールしたら
        if (appear == false) {
          appear = true;
          pagetop.stop().animate(
            {
              bottom: "20px", //下から15pxの位置に
            },
            {
              duration: 500,
              easing: "easeInOutQuad",
            }
          ); //0.5秒かけて現れる
        }
      } else {
        if (appear) {
          appear = false;
          pagetop.stop().animate(
            {
              bottom: "-50px", //下から-50pxの位置に
            },
            {
              duration: 500,
              easing: "easeInOutQuad",
            }
          ); //0.5秒かけて隠れる
        }
      }
    });
    pagetop.click(function () {
      $("body, html").animate(
        {
          scrollTop: 0,
        },
        {
          duration: 1400,
          easing: "easeInOutQuint",
        }
      ); //1.4秒かけてトップへ戻る
      return false;
    });
  }

  /*----------------------
     slick
    ------------------------*/

  function slider_set() {
    $(".slider_fv").slick({
      infinite: true,
      slidesToShow: 1,
      dots: false,
      arrows: false,
      autoplay: true,
      autoplaySpeed: 6000,
      speed: 3000,
      fade: true,
      responsive: [
        {
          breakpoint: 800,
          settings: {
            slidesToShow: 1,
            arrows: false,
          },
        },
      ],
    });

    $(".slider").slick({
      infinite: true,
      slidesToShow: 4,
      autoplay: true,
      autoplaySpeed: 8000,
      dots: false,
      responsive: [
        {
          breakpoint: 800,
          settings: {
            slidesToShow: 1,
          },
        },
      ],
    });
  }

  /*----------------------
     ToggleMenu
  ------------------------*/

  //MenuOpenFlag
  spmenuSet();

  function spmenuSet() {
    $("#sp_navigation").on("click", function () {
      if (spmenuFlag === false && spmenuOpenFlag === false) {
        spmenuFlag = true;
        scrollpos = $(window).scrollTop();
        $("body").addClass("menu_fixed").css({
          top: -scrollpos,
        });
        $(".menu-trigger").addClass("active");
        $("#sp_navigation").addClass("active");
        $("#menu_fade").addClass("active");
        spmenuFlag = false;
        spmenuOpenFlag = true;
        console.log(scrollpos);
        return false;
      } else if (spmenuFlag === false && spmenuOpenFlag === true) {
        spmenuFlag = true;
        $("body").removeClass("menu_fixed").css({
          top: 0,
        });
        window.scrollTo(0, scrollpos);
        $(".menu-trigger").removeClass("active");
        $("#sp_navigation").removeClass("active");
        $("#menu_fade").removeClass("active");
        setTimeout(menureset, 800);

        function menureset() {
          spmenuFlag = false;
          spmenuOpenFlag = false;
          return false;
        }
      }
    });
  }

  /*----------------------
       accordion
      ------------------------*/

  function accordion() {
    jQuery(".trigger").on("click", function () {
      jQuery(this).next().slideToggle();
      // activeが存在する場合
      if (jQuery(this).hasClass("active")) {
        // activeを削除
        jQuery(this).removeClass("active");
      } else {
        // activeを追加
        jQuery(this).addClass("active");
      }
    });
  }
});
