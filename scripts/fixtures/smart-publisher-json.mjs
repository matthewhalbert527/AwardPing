// Sanitized SYNTHETIC programme and account values. No captures, session data or nonces.
// Reviewed public static controller/template binding strings are kept for strict guards.
const FIXTURES = {
  "home": {
    "result": {
      "$$uiNotification": [],
      "metatags": [],
      "theme": {
        "header": {
          "sys_id": "69505de91bce90107695a82fe54bcbc1",
          "public": true,
          "roles": "",
          "async_load": false,
          "options": {
            "async_load": false
          },
          "template": "<noscript> Synthetic rule 1 </noscript>\n<img style=\"display:none\" src=\"https://data.adxcel-ec2.com/pixel/?ad_log=referer&amp;action=lead&amp;pixid=18d72af0-9a7a-4735-9776-7dd2a91bcbd0\" width=\"1\" height=\"1\" border=\"0\">\n<noscript> Synthetic rule 2 </noscript>\n<script></script>\n<script></script>\n<script type=\"application/ld+json\"></script>\n<div class=\"announcement\"><sp-widget widget=\"c.data.announcementWidget\"></sp-widget>\n</div>\n<div class=\"menusFixed\">\n <div class=\"toggle\">\n  <div class=\"row togglerow\">\n   <div class=\"col-md-12 right\"><button class=\"navbar-toggler p-5 border-0\" type=\"button\" data-toggle=\"collapse\" data-target=\".navbar-collapse\"> <i class=\"fa fa-bars fa-2x\" aria-hidden=\"true\"></i> </button>\n   </div>\n  </div>\n  <div class=\"navbar-collapse collapse nopadding\" aria-expanded=\"false\">\n   <div class=\"nav-container\"><sp-widget widget=\"data.menu\"></sp-widget>\n    <ul class=\"nav navbar-nav\">\n     <li><a href=\"https://mailchi.mp/e696f3ce2730/smart\" target=\"_blank\"> Synthetic rule 3 </a></li>\n     <li ng-if=\"!user.logged_in &amp;&amp; page.id != portal.login_page_dv &amp;&amp; !data.hasLogin\"><a href=\"\" ng-click=\"LoginRedirect()\"> Synthetic rule 4 </a></li>\n     <li ng-if=\"user.logged_in\" class=\"dropdown hidden-sm\"><a href=\"javascript:void(0)\" class=\"dropdown-toggle\" data-toggle=\"dropdown\" aria-expanded=\"false\" title=\"{{data.profileBtnMsg}}\" id=\"profile-dropdown\"> <span class=\"navbar-avatar\">\n        <sn-avatar class=\"avatar-small-medium\" primary=\"userID\"></sn-avatar></span> <span class=\"visible-lg-inline\"> {{::user.name}} </span>\n       <sp-widget widget=\"c.data.announcementPicker\"></sp-widget> </a>\n      <ul class=\"dropdown-menu\" role=\"menu\">\n       <li><a ng-href=\"?id=user_profile&amp;sys_id={{::user.sys_id}}\" role=\"menuitem\"> Synthetic rule 5 </a></li>\n       <li ng-if=\"::!isViewNative\"><a href=\"{{::portal.logoutUrl}}\" role=\"menuitem\"> Synthetic rule 6 </a></li>\n      </ul></li>\n     <li ng-if=\"user.logged_in\" class=\"visible-xs-block\"><a ng-href=\"?id=user_profile&amp;sys_id={{::user.sys_id}}\"> {{::user.name}} </a></li>\n     <li ng-if=\"::!isViewNative &amp;&amp; user.logged_in\" class=\"visible-xs-block\"><a href=\"{{::portal.logoutUrl}}\"> Synthetic rule 7 </a></li>\n    </ul>\n   </div>\n  </div>\n </div>\n <div class=\"row navtop notmobile\">\n  <div class=\"col-lg-8\">\n  </div>\n  <div class=\"col-lg-4\">\n   <div class=\"navbar-right login-container\" align=\"center\">\n    <ul ng-if=\"(!user.logged_in &amp;&amp; page.id != portal.login_page_dv &amp;&amp; !data.hasLogin)\" class=\"navbar-nav\">\n     <li><a href=\"\" ng-click=\"LoginRedirect()\"> Synthetic rule 8 </a></li>\n    </ul>\n    <ul ng-if=\"::user.logged_in\" aria-haspopup=\"true\" data-toggle=\"dropdown\">\n     <li class=\"dropdown hidden-xs\"><a href=\"javascript:void(0)\" class=\"dropdown-toggle\" data-toggle=\"dropdown\" aria-expanded=\"false\" title=\"{{data.profileBtnMsg}}\" id=\"profile-dropdown\"> <span class=\"navbar-avatar\">\n        <sn-avatar class=\"avatar-small-medium\" primary=\"userID\"></sn-avatar></span> <span class=\"visible-lg-inline visible-md-inline visible-sm-inline\"> {{::user.name}} </span>\n       <sp-widget widget=\"c.data.announcementPicker\"></sp-widget> </a>\n      <ul class=\"dropdown-menu\" role=\"menu\">\n       <li><a ng-href=\"?id=user_profile&amp;sys_id={{::user.sys_id}}\" role=\"menuitem\"> Synthetic rule 9 </a></li>\n       <li ng-if=\"::!isViewNative\"><a href=\"{{::portal.logoutUrl}}\" role=\"menuitem\"> Synthetic rule 10 </a></li>\n      </ul></li>\n     <li class=\"visible-xs-block\"><a ng-href=\"?id=user_profile&amp;sys_id={{::user.sys_id}}\"><span class=\"navbar-avatar\">\n        <sn-avatar class=\"avatar-small-medium\" primary=\"userID\"></sn-avatar></span> {{::user.name}} </a></li>\n     <li ng-if=\"::!isViewNative\" class=\"visible-xs-block\"><a href=\"{{::portal.logoutUrl}}\"> Synthetic rule 11 </a></li>\n    </ul>\n   </div>\n   <div class=\"navbar-right subscribe-container\">\n    <ul class=\"nav navbar-nav\">\n     <li><a href=\"https://mailchi.mp/e696f3ce2730/smart\" target=\"_blank\"> Synthetic rule 12 </a></li>\n    </ul>\n   </div>\n  </div>\n </div>\n <div class=\"row navmiddle\">\n  <div class=\"col-md-6 col-sm-7 main-container\"><span class=\"logos\"> <img src=\"../DOW-Seal.png\" alt=\"The DoW Logo\" class=\"imgWidth\" role=\"presentation\"> </span> <span class=\"navtitle\">\n    <div class=\"navdod\"> Synthetic rule 13 </div>\n    <div> Synthetic rule 14 </div> </span>\n  </div>\n  <div class=\"col-md-6 col-sm-5 main-container no-mobile\">\n   <div class=\"app-info\" ng-if=\"data.showClosedWarning\"><span class=\"titleClosedWarning\"> Synthetic rule 15 <span class=\"closedWarningText\"> {{data.pyOpenNextYear}} </span> </span>\n   </div>\n   <div class=\"app-clock\" ng-if=\"!data.showClosedWarning\">\n    <div ng-if=\"data.showApply\"><sp-widget ng-if=\"data.wCountdown\" widget=\"data.wCountdown\"></sp-widget>\n    </div>\n   </div>\n  </div>\n </div>\n <div class=\"row navbottom\">\n  <div class=\"col-md-11\">\n   <div class=\"nav-container mainnav\">\n    <nav role=\"navigation\"><sp-widget widget=\"data.menu\"></sp-widget>\n    </nav>\n   </div>\n  </div>\n </div>\n</div>",
          "client_script": "function ($rootScope, $window, $scope, snRecordWatcher, spUtil, spModal, $location, $uibModal, cabrillo, $timeout, glideSystemProperties) {\n\tvar c = this;\n\t$('#navigation #navMenu li a').click(function() {\n\t\talert($(this).text());\n\t\t$('.offcanvas-collapse').toggleClass('open');\n\t});\n\t\n\t$scope.userID = $scope.user.sys_id;\n\tif (cabrillo.isNative())\n\t\t$scope.isViewNative = true;\t\n\t\t\n\t$scope.openPopUp = function() {\n\t\tvar url = \"$chat_support.do?queueID=\" + $scope.data.connect_support_queue_id;\n\t\tvar popup = window.open (url, \"popup\", \"width=900, height=600\");\n\t};\n\t$scope.openLogin = function () {\n\t\t$scope.modalInstance = $uibModal.open({\n\t\t\ttemplateUrl: 'modalLogin',\n\t\t\tscope: $scope\n\t\t});\n\t};\n\t$rootScope.$on('sp.avatar_changed', function() {\n\t\t$scope.userID = \"\";\n\t\t$timeout(function(){\n\t\t\t$scope.userID = $scope.user.sys_id;\n\t\t});\n\t});\n\t$scope.isHomepage = function() {\n\t\tif (!$scope.page.id)\n\t\t\treturn true;\n\t\tif ($scope.page.id == $scope.portal.homepage_dv)\n\t\t\treturn true;\n\t\treturn false;\n\t};\n\tvar shared={};\n\t$scope.mailListSubscribe = function(widgetId, widgetInput) {\n\t\tspModal.open({\n\t\t\ttitle: 'SMART Subscription Form',\n\t\t\twidget: widgetId,\n\t\t\twidgetInput: widgetInput || {},\n\t\t\tbuttons: [{label: 'Close', primary: true}],\n\t\t\tshared: shared\n\t\t}).then(function(){\n\t\t})\n\t\t\n\t};\n\t\n\t$scope.LoginRedirect = function() {\n$window.location = 'https://'+ $window.location.hostname +\"/smart?id=login\";\n\t};\n}\n",
          "data": {
            "announcementPicker": {},
            "menu": {
              "sys_id": "5ef595c1cb12020000f8d856634c9c6e",
              "public": true,
              "roles": "",
              "async_load": false,
              "options": {
                "async_load": false
              },
              "template": "<p>Excluded synthetic UI.</p>",
              "client_script": "",
              "data": {
                "replace": true,
                "isLoggedIn": false,
                "showWishlist": false,
                "guidedTours": null,
                "menu": {},
                "showTours": false
              }
            },
            "typeahead": {},
            "showApply": true,
            "wCountdown": {
              "sys_id": "5947caa91bfc94107695a82fe54bcb5f",
              "public": true,
              "roles": "",
              "async_load": false,
              "options": {
                "async_load": false
              },
              "template": "<div ng-show=\"data.showCountDown\"><sp-widget widget=\"data.countDownWidget\"></sp-widget>\n</div>",
              "client_script": "function($scope, spUtil) {\n\tvar c = this;\n\t\n\tspUtil.recordWatch($scope, \"x_smart_program_year\", \"active=false\", function(name) {\n\t\t\t\n\t\tc.server.refresh();\n\t});\n\t\n}\n",
              "data": {
                "showCountDown": true,
                "countDownWidget": {
                  "sys_id": "281b37e04f6e13004b5c30318110c74d",
                  "public": true,
                  "roles": "",
                  "async_load": false,
                  "options": {
                    "async_load": false
                  },
                  "template": "<div><span class=\"apptitle\" id=\"apptitle\"> Synthetic rule 16 {{data.status}} Synthetic rule 17 </span> <span id=\"clockdiv\">\n  <div>\n   <div class=\"smalltext\"> Synthetic rule 18 </div><span class=\"days\"></span>\n  </div>\n  <div>\n   <div class=\"smalltext\"> Synthetic rule 19 </div><span class=\"hours\"></span>\n  </div>\n  <div>\n   <div class=\"smalltext\"> Synthetic rule 20 </div><span class=\"minutes\"></span>\n  </div>\n  <div class=\"hidden\">\n   <div class=\"smalltext\"> Synthetic rule 21 </div><span class=\"seconds\"></span>\n  </div> </span>\n</div>",
                  "client_script": "function($scope, spUtil) {\n\tvar c = this;\n\tfunction getTimeRemaining(endtime) {\n  var t = Date.parse(endtime) - Date.parse(new Date());\nvar seconds = Math.floor((t / 1000) % 60);\nvar minutes = Math.floor((t / 1000 / 60) % 60);\nvar hours = Math.floor((t / (1000 * 60 * 60)) % 24);\nvar days = Math.floor(t / (1000 * 60 * 60 * 24));\n  return {\n    'total': t,\n    'days': days,\n    'hours': hours,\n    'minutes': minutes,\n    'seconds': seconds\n  };\n}\nfunction initializeClock(id, endtime) {\n  var clock = document.getElementById(id);\n\tvar app = document.getElementById('apptitle');\n  var daysSpan = clock.querySelector('.days');\n  var hoursSpan = clock.querySelector('.hours');\n  var minutesSpan = clock.querySelector('.minutes');\n  var secondsSpan = clock.querySelector('.seconds');\n  function updateClock() {\n    var t = getTimeRemaining(endtime);\n\t\tif (t.days.toString().length == 1){\n\t\t\tdaysSpan.innerHTML = ('0' + t.days).slice(-2);\n\t\t}\n\t\telse{\n\t\t\tdaysSpan.innerHTML = t.days;\n\t\t}\n    hoursSpan.innerHTML = ('0' + t.hours).slice(-2);\n    minutesSpan.innerHTML = ('0' + t.minutes).slice(-2);\n    secondsSpan.innerHTML = ('0' + t.seconds).slice(-2);\t\t\n\t\t\n    if (t.total <= 0) {\n\t\t\tclock.style.display = \"none\";\n\t\t\tapp.style.display = \"none\";\n      clearInterval(timeinterval);\n    }\n  }\n  updateClock();\n  var timeinterval = setInterval(updateClock, 1000);\n}\nvar deadline = new Date($scope.data.deadLine);\ninitializeClock('clockdiv', deadline);\n\t\n\t\n\t\n\t\n}\n",
                  "data": {
                    "visible": true,
                    "deadLine": 2000000000000,
                    "status": "Closes"
                  }
                }
              },
              "link": "function link(scope, element, attrs, controller) { \n\n }"
            },
            "connect_support_queue_id": "Synthetic value",
            "login_page": "Synthetic value",
            "showClosedWarning": false,
            "profileBtnMsg": "Synthetic value",
            "pyOpenNextYear": "Synthetic value",
            "hasLogin": false,
            "announcementWidget": {
              "sys_id": "1e6a42edd442b2007f44c8341d4d3b57",
              "public": true,
              "roles": "",
              "async_load": false,
              "options": {
                "async_load": false
              },
              "template": "<p>Excluded synthetic UI.</p>",
              "client_script": "",
              "data": {
                "showAnnouncements": true,
                "outages": [],
                "informationAnnouncementIDs": "Synthetic value",
                "informationAnnouncements": [],
                "outageIDs": "Synthetic value"
              }
            },
            "loginWidget": {
              "sys_id": "6506d341cb33020000f8d856634c9cdc",
              "public": true,
              "roles": "",
              "async_load": false,
              "options": {
                "async_load": false
              },
              "template": "<p>Excluded synthetic UI.</p>",
              "client_script": "",
              "data": {
                "usernameMsg": "Synthetic value",
                "certAuthRedirect": false,
                "isMultiSSOActive": false,
                "pageURI": "/smart",
                "forgetMe": true,
                "rememberMeDefault": false,
                "passwordMsg": "Synthetic value",
                "multisso_enabled": false,
                "default_idp": null,
                "errorMsg": "Synthetic value",
                "isShowLoginWithIdps": false,
                "is_logged_in": false,
                "errorMsg2": "Synthetic value",
                "pswdResetUrl": "Synthetic value",
                "forgotPwdLinkProp": "Synthetic value",
                "multiFactorAuthEnabled": true,
                "ssoSelectorFieldLabel": "Synthetic value"
              }
            }
          },
          "link": "function(scope, element) {\n\t$('[data-toggle=\"offcanvas\"]').on('click', function () {\n    $('.offcanvas-collapse').toggleClass('open');\n  });\n\t\n\t$(document).keyup(function(event) {\n\t\tif (event.which == 9) { //tab key handler + arrow keys\n\t\t\tif ($(event.target).parents(\".dropdown-menu\").length == 0) { //if we are NOT inside a dropdown...\n\t\t\t\t//close the dropdowns\n\t\t\t\t$(\".dropdown\").removeClass(\"open\");\n\t\t\t\t$(\"[data-toggle='dropdown']\").attr(\"aria-expanded\", \"false\");\n\t\t\t}\n\t\t}\n\t});\n\t\n\t$(element).on('click.nav','.navbar-collapse.in',function(e) {\n\t\tvar target = $(e.target);\n\t\tif (target.is('a')) {\n\t\t\tif (target.hasClass('sp-menu-has-items'))\n\t\t\t\treturn; // menu item has a submenu, so just toggle it\n\t\t\t\n\t\t\t// collapse mobile nav if clicked an anchor\n\t\t\t$(this).removeClass('in').addClass('collapse');\n\t\t\tconsole.log('link function');\n\t\t\treturn;\n\t\t}\n\n\t\tif (target.parent().hasClass(\"toggle-dropdown\")) {\n\t\t\t// collapse mobile nav if parent has toggle-dropdown class\n\t\t\t$(this).removeClass('in').addClass('collapse');\n\t\t\tconsole.log('link function');\n\t\t\treturn;\n\t\t}\n\n\t\t// if neither target nor parent is an anchor, do nothing\n\t\tif (!target.parent().is('a'))\n\t\t\treturn;\n\n\t\t// collapse mobile nav if target is part of a submenu\n\t\tif (target.parents(\"ul.dropdown-menu\").length > 0){\n\t\t\t$(this).removeClass('in').addClass('collapse');\n\t\t\tconsole.log('link function');\n\t\t}\n\t});\n}"
        },
        "footer": {
          "sys_id": "f908e94fdb350300ecc734cc7c9619b2",
          "public": true,
          "roles": "",
          "async_load": false,
          "options": {
            "async_load": false
          },
          "template": "<p>Excluded synthetic UI.</p>",
          "client_script": "",
          "data": {
            "showLinks": true,
            "portal": "smart"
          }
        }
      },
      "containers": [
        {
          "sys_id": "be98a8d2cb20020000f8d856634c9c63",
          "bootstrap_alt": false,
          "subheader": false,
          "background": "{\"background-size\":\"initial\",\"background-position\":\"center center\"}",
          "width": "container-fluid",
          "container_class_name": "padding",
          "title": "",
          "rows": [
            {
              "sys_id": "fd29a8d2cb20020000f8d856634c9cc6",
              "columns": [
                {
                  "sys_id": "1339e8d2cb20020000f8d856634c9c41",
                  "size_classes": "col-sm-12 ",
                  "rows": [
                    {
                      "sys_id": "e5454a0f1be161101c91426de54bcb21",
                      "columns": [
                        {
                          "sys_id": "a9454a0f1be161101c91426de54bcb24",
                          "size_classes": "col-md-12 ",
                          "rows": [],
                          "widgets": [
                            {
                              "sys_id": "e345860f1be161101c91426de54bcb0c",
                              "widget": {
                                "sys_id": "6b86714a1b2dad507695a82fe54bcbac",
                                "public": true,
                                "roles": "",
                                "async_load": false,
                                "options": {
                                  "async_load": false
                                },
                                "template": "<div ng-if=\"c.data.smart_carousel\"><sp-widget widget=\"c.data.smart_carousel\"></sp-widget>\n</div>\n<div class=\"front\" role=\"img\" aria-label=\"Background image of abstract geometry.\">\n <div class=\"slick-slide\">\n  <h1 class=\"titleText\"> Synthetic rule 22 <br> Synthetic rule 23 </h1>\n  <div class=\"titleDesc\"> Synthetic rule 24 <br> Synthetic rule 25 </div>\n  <div class=\"buttons\"><a href=\"../smart/en?id=application_registration\" ng-if=\"data.showApplyButton\">\n    <div class=\"button-container-active\"> Synthetic rule 26 </div> </a> <a href=\"smart/en?id=smart_opportunities\">\n    <div class=\"button-container\"> Synthetic rule 27 </div> </a> <a href=\"../smart/en?id=about_smart\">\n    <div class=\"button-container\"> Synthetic rule 28 </div> </a> <a href=\"../smart/en?id=evaluator_registration_part_i\" ng-if=\"data.showPanelistRegButton\">\n    <div class=\"button-container\" data-toggle=\"tooltip\" data-placement=\"top\" title=\"Register to become an Evaluation Panelist\"> Synthetic rule 29 </div> </a> <a href=\"../eval\" ng-if=\"data.showPanelistButton\">\n    <div class=\"button-container\" data-toggle=\"tooltip\" data-placement=\"top\" title=\"Evaluation Portal\"> Synthetic rule 30 </div> </a> <a href=\"../selection_portal\" ng-if=\"data.showSelectionButton\">\n    <div class=\"button-container\" data-toggle=\"tooltip\" data-placement=\"top\" title=\"Selection Portal\"> Synthetic rule 31 </div> </a>\n  </div>\n </div>\n</div>\n<sp-widget widget=\"c.data.program_and_eligibility\"></sp-widget>\n<sp-widget widget=\"c.data.future_leaders\"></sp-widget>\n<div class=\"benefits-container\">\n <h2> Synthetic rule 32 </h2>\n <div class=\"benefits-cards\">\n  <div class=\"row\">\n   <div class=\"col-lg-3 col-md-6 col-sm-6 benefits-cards-main\">\n    <div class=\"benefits-cards-title\"> Synthetic rule 33 </div>\n    <div> Synthetic rule 34 </div>\n   </div>\n   <div class=\"col-lg-3 col-md-6 col-sm-6 benefits-cards-stipend\" role=\"img\" aria-label=\"Background photograph of four students studying and smiling.\">\n    <div class=\"benefits-cards-title\"> Synthetic rule 35 </div>\n    <div> Synthetic rule 36 {{data.stipendText}} Synthetic rule 37 </div>\n   </div>\n   <div class=\"col-lg-3 col-md-6 col-sm-6 benefits-cards-main\">\n    <div class=\"benefits-cards-title\"> Synthetic rule 38 </div>\n    <div> Synthetic rule 39 </div>\n   </div>\n   <div class=\"col-lg-3 col-md-6 col-sm-6 benefits-cards-career\" role=\"img\" aria-label=\"Background photograph of five students smiling for the camera.\">\n    <div class=\"benefits-cards-title\"> Synthetic rule 40 </div>\n    <div> Synthetic rule 41 </div>\n   </div>\n  </div>\n </div>\n</div>\n<sp-widget widget=\"c.data.scholar_recipients\"></sp-widget>\n<div class=\"number-container\">\n <div class=\"row\">\n  <div class=\"col-md-4 col-xs-12\"><span class=\"numbers-container\">\n    <div class=\"numbers-text\"> {{data.facilities | number}} </div> </span>\n   <hr>\n   <div class=\"numbers-info\"> Synthetic rule 42 </div>\n  </div>\n  <div class=\"col-md-4 col-xs-12\"><span class=\"numbers-container\">\n    <div class=\"numbers-text\"> {{data.scholars | number}} </div> </span>\n   <hr>\n   <div class=\"numbers-info\"> Synthetic rule 43 </div>\n  </div>\n  <div class=\"col-md-4 col-xs-12\"><span class=\"numbers-container\">\n    <div class=\"numbers-text\"> Synthetic rule 44 </div> </span>\n   <hr>\n   <div class=\"numbers-info\"> Synthetic rule 45 </div>\n  </div>\n </div>\n</div>",
                                "client_script": "api.controller=function($scope) {\n  var c = this;\n};\n",
                                "data": {
                                  "showSelectionButton": false,
                                  "future_leaders": {
                                    "sys_id": "c9795b2847b89210c205f9ee626d43f2",
                                    "public": true,
                                    "roles": "",
                                    "async_load": false,
                                    "options": {
                                      "async_load": false
                                    },
                                    "template": "<div class=\"section-container\" ng-class=\"{'front-template': c.data.background != ''}\">\n <div class=\"row section-body\" ng-class=\"{'slick-slide': c.data.background != ''}\">\n  <div class=\"col-xs-12 section-image onlymobile\" ng-if=\"data.image_location == 'right'\"><sp-widget widget=\"c.data.image_widget\"></sp-widget>\n  </div>\n  <div class=\"col-md-3 col-sm-4 col-xs-12  section-image\" ng-if=\"data.image_location == 'left'\"><sp-widget widget=\"c.data.image_widget\"></sp-widget>\n  </div>\n  <div class=\"col-md-9 col-sm-8 col-xs-12\" ng-class=\"{'section-main': c.data.image_location == 'left'}\">\n   <h2> {{c.data.title}} </h2>\n   <div class=\"section-description\" ng-bind-html=\"data.description\"></div>\n   <div class=\"buttons\"><a ng-repeat=\"b in data.buttons\" ng-href=\"{{b.href}}\">\n     <div class=\"button-container\" ng-class=\"{'button-container-active': b.active === true}\"> {{b.title}} </div> </a>\n   </div>\n   <div class=\"section-container-group\">\n    <div class=\"section\" ng-repeat=\"section in data.sections\"><img ng-src=\"{{ section.image }}\" alt=\"{{ section.title }} Icon\">\n     <div class=\"section-info\"><span class=\"section-title\"> {{ section.title }} Synthetic rule 46 </span> <span class=\"section-description\"> {{ section.description }} </span>\n     </div>\n    </div>\n   </div>\n  </div>\n  <div class=\"col-md-3 col-sm-4 col-xs-12 notmobile\" ng-if=\"data.image_location == 'right'\"><sp-widget widget=\"c.data.image_widget\"></sp-widget>\n  </div>\n </div>\n</div>",
                                    "client_script": "api.controller=function() {\n  var c = this;\n};\n",
                                    "data": {
                                      "image_fit": "Synthetic value",
                                      "buttons": [
                                        {
                                          "active": false,
                                          "href": "/smart/en?id=synthetic_0",
                                          "title": "Synthetic button 0"
                                        },
                                        {
                                          "active": false,
                                          "href": "/smart/en?id=synthetic_1",
                                          "title": "Synthetic button 1"
                                        }
                                      ],
                                      "image_attachment_filename": "Synthetic value",
                                      "image_alt": "Synthetic value",
                                      "description": "<p>Synthetic requirement paragraph.</p><p>Whole second requirement.</p>",
                                      "image_attachment": "Synthetic value",
                                      "image_title": "",
                                      "title": "Synthetic programme heading",
                                      "image_src": "Synthetic value",
                                      "image_widget": {
                                        "sys_id": "dda3e7808762fe105831a7530cbb3596",
                                        "public": true,
                                        "roles": "",
                                        "async_load": false,
                                        "options": {
                                          "async_load": false
                                        },
                                        "template": "<div class=\"section-image\"><a href=\"{{data.image_attachment}}\" target=\"_blank\" ng-if=\"data.image_attachment != ''\" ng-class=\"{'image-fit': c.data.image_fit == 'fit'}\" ng-click=\"googleTagMgr(c.data.image_attachment_filename)\"> <img src=\"{{data.image_src}}\" alt=\"{{data.image_alt}}\">\n  <div class=\"image-title\" ng-if=\"data.image_title != ''\"> {{c.data.image_title}} </div>\n  <div class=\"overlay overlayeffect\" ng-if=\"data.image_overlay == true\"><i class=\"fa fa-external-link fa-4x\" aria-hidden=\"true\" width=\"100\" height=\"50\" style=\"filter: brightness(0) invert(1);\"></i>\n  </div> </a> <span ng-if=\"data.image_attachment == ''\" ng-class=\"{'image-fit': c.data.image_fit == 'fit'}\"> <img src=\"{{data.image_src}}\" alt=\"{{data.image_alt}}\">\n  <div class=\"image-title\" ng-if=\"data.image_title != ''\"> {{c.data.image_title}} </div>\n  <div class=\"overlay overlayeffect\" ng-if=\"data.image_overlay == true\"><i class=\"fa fa-external-link fa-4x\" aria-hidden=\"true\" width=\"100\" height=\"50\" style=\"filter: brightness(0) invert(1);\"></i>\n  </div> </span>\n</div>",
                                        "client_script": "api.controller=function($scope) {\n  var c = this;\n\t\n\t$scope.googleTagMgr = function(fileName) {\n\t\tvar extension = fileName.split('.').pop();\n\t\tswitch (extension){\n\t\t\tcase 'pdf':\n\t\t\t\tdataLayer.push({\n\t\t\t\t\t'event': 'pdf_download_servicenow',\n'pdfFileName': fileName,\n'downloadPage': window.location\n\t\t\t\t});\n\t\t\t\tbreak;\n\t\t\tdefault:\t\t\t\t\n\t\t\t\tdataLayer.push({\n\t\t\t\t\t'event': 'image_download_servicenow',\n'imgFileName': fileName,\n'downloadPage': window.location\n\t\t\t\t});\n\t\t\t\tbreak;\n\t\t}\t\t\n\t};\n\t\n};\n",
                                        "data": {
                                          "image_fit": "Synthetic value",
                                          "image_overlay": "false",
                                          "image_attachment_filename": "Synthetic value",
                                          "image_alt": "Synthetic value",
                                          "image_attachment": "Synthetic value",
                                          "image_title": "",
                                          "image_src": "Synthetic value"
                                        },
                                        "link": "function link(scope, element, attrs, controller) { \n\n }"
                                      },
                                      "image_overlay": "false",
                                      "background": "Synthetic value",
                                      "image_location": "right"
                                    },
                                    "link": "function link(scope, element, attrs, controller) { \n\n }"
                                  },
                                  "scholar_recipients": {
                                    "sys_id": "c9795b2847b89210c205f9ee626d43f2",
                                    "public": true,
                                    "roles": "",
                                    "async_load": false,
                                    "options": {
                                      "async_load": false
                                    },
                                    "template": "<div class=\"section-container\" ng-class=\"{'front-template': c.data.background != ''}\">\n <div class=\"row section-body\" ng-class=\"{'slick-slide': c.data.background != ''}\">\n  <div class=\"col-xs-12 section-image onlymobile\" ng-if=\"data.image_location == 'right'\"><sp-widget widget=\"c.data.image_widget\"></sp-widget>\n  </div>\n  <div class=\"col-md-3 col-sm-4 col-xs-12  section-image\" ng-if=\"data.image_location == 'left'\"><sp-widget widget=\"c.data.image_widget\"></sp-widget>\n  </div>\n  <div class=\"col-md-9 col-sm-8 col-xs-12\" ng-class=\"{'section-main': c.data.image_location == 'left'}\">\n   <h2> {{c.data.title}} </h2>\n   <div class=\"section-description\" ng-bind-html=\"data.description\"></div>\n   <div class=\"buttons\"><a ng-repeat=\"b in data.buttons\" ng-href=\"{{b.href}}\">\n     <div class=\"button-container\" ng-class=\"{'button-container-active': b.active === true}\"> {{b.title}} </div> </a>\n   </div>\n   <div class=\"section-container-group\">\n    <div class=\"section\" ng-repeat=\"section in data.sections\"><img ng-src=\"{{ section.image }}\" alt=\"{{ section.title }} Icon\">\n     <div class=\"section-info\"><span class=\"section-title\"> {{ section.title }} Synthetic rule 47 </span> <span class=\"section-description\"> {{ section.description }} </span>\n     </div>\n    </div>\n   </div>\n  </div>\n  <div class=\"col-md-3 col-sm-4 col-xs-12 notmobile\" ng-if=\"data.image_location == 'right'\"><sp-widget widget=\"c.data.image_widget\"></sp-widget>\n  </div>\n </div>\n</div>",
                                    "client_script": "api.controller=function() {\n  var c = this;\n};\n",
                                    "data": {
                                      "image_fit": "Synthetic value",
                                      "buttons": [
                                        {
                                          "active": false,
                                          "href": "/smart/en?id=synthetic_0",
                                          "title": "Synthetic button 0"
                                        },
                                        {
                                          "active": false,
                                          "href": "/smart/en?id=synthetic_1",
                                          "title": "Synthetic button 1"
                                        }
                                      ],
                                      "image_attachment_filename": "Synthetic value",
                                      "image_alt": "Synthetic value",
                                      "description": "<p>Synthetic requirement paragraph.</p><p>Whole second requirement.</p>",
                                      "image_attachment": "Synthetic value",
                                      "image_title": "",
                                      "title": "Synthetic programme heading",
                                      "image_src": "Synthetic value",
                                      "image_widget": {
                                        "sys_id": "dda3e7808762fe105831a7530cbb3596",
                                        "public": true,
                                        "roles": "",
                                        "async_load": false,
                                        "options": {
                                          "async_load": false
                                        },
                                        "template": "<div class=\"section-image\"><a href=\"{{data.image_attachment}}\" target=\"_blank\" ng-if=\"data.image_attachment != ''\" ng-class=\"{'image-fit': c.data.image_fit == 'fit'}\" ng-click=\"googleTagMgr(c.data.image_attachment_filename)\"> <img src=\"{{data.image_src}}\" alt=\"{{data.image_alt}}\">\n  <div class=\"image-title\" ng-if=\"data.image_title != ''\"> {{c.data.image_title}} </div>\n  <div class=\"overlay overlayeffect\" ng-if=\"data.image_overlay == true\"><i class=\"fa fa-external-link fa-4x\" aria-hidden=\"true\" width=\"100\" height=\"50\" style=\"filter: brightness(0) invert(1);\"></i>\n  </div> </a> <span ng-if=\"data.image_attachment == ''\" ng-class=\"{'image-fit': c.data.image_fit == 'fit'}\"> <img src=\"{{data.image_src}}\" alt=\"{{data.image_alt}}\">\n  <div class=\"image-title\" ng-if=\"data.image_title != ''\"> {{c.data.image_title}} </div>\n  <div class=\"overlay overlayeffect\" ng-if=\"data.image_overlay == true\"><i class=\"fa fa-external-link fa-4x\" aria-hidden=\"true\" width=\"100\" height=\"50\" style=\"filter: brightness(0) invert(1);\"></i>\n  </div> </span>\n</div>",
                                        "client_script": "api.controller=function($scope) {\n  var c = this;\n\t\n\t$scope.googleTagMgr = function(fileName) {\n\t\tvar extension = fileName.split('.').pop();\n\t\tswitch (extension){\n\t\t\tcase 'pdf':\n\t\t\t\tdataLayer.push({\n\t\t\t\t\t'event': 'pdf_download_servicenow',\n'pdfFileName': fileName,\n'downloadPage': window.location\n\t\t\t\t});\n\t\t\t\tbreak;\n\t\t\tdefault:\t\t\t\t\n\t\t\t\tdataLayer.push({\n\t\t\t\t\t'event': 'image_download_servicenow',\n'imgFileName': fileName,\n'downloadPage': window.location\n\t\t\t\t});\n\t\t\t\tbreak;\n\t\t}\t\t\n\t};\n\t\n};\n",
                                        "data": {
                                          "image_fit": "Synthetic value",
                                          "image_overlay": "false",
                                          "image_attachment_filename": "Synthetic value",
                                          "image_alt": "Synthetic value",
                                          "image_attachment": "Synthetic value",
                                          "image_title": "",
                                          "image_src": "Synthetic value"
                                        },
                                        "link": "function link(scope, element, attrs, controller) { \n\n }"
                                      },
                                      "image_overlay": "false",
                                      "background": "Synthetic value",
                                      "image_location": "left"
                                    },
                                    "link": "function link(scope, element, attrs, controller) { \n\n }"
                                  },
                                  "showApplyButton": true,
                                  "stipendText": "$100-$200",
                                  "showPanelistButton": false,
                                  "program_and_eligibility": {
                                    "sys_id": "c9795b2847b89210c205f9ee626d43f2",
                                    "public": true,
                                    "roles": "",
                                    "async_load": false,
                                    "options": {
                                      "async_load": false
                                    },
                                    "template": "<div class=\"section-container\" ng-class=\"{'front-template': c.data.background != ''}\">\n <div class=\"row section-body\" ng-class=\"{'slick-slide': c.data.background != ''}\">\n  <div class=\"col-xs-12 section-image onlymobile\" ng-if=\"data.image_location == 'right'\"><sp-widget widget=\"c.data.image_widget\"></sp-widget>\n  </div>\n  <div class=\"col-md-3 col-sm-4 col-xs-12  section-image\" ng-if=\"data.image_location == 'left'\"><sp-widget widget=\"c.data.image_widget\"></sp-widget>\n  </div>\n  <div class=\"col-md-9 col-sm-8 col-xs-12\" ng-class=\"{'section-main': c.data.image_location == 'left'}\">\n   <h2> {{c.data.title}} </h2>\n   <div class=\"section-description\" ng-bind-html=\"data.description\"></div>\n   <div class=\"buttons\"><a ng-repeat=\"b in data.buttons\" ng-href=\"{{b.href}}\">\n     <div class=\"button-container\" ng-class=\"{'button-container-active': b.active === true}\"> {{b.title}} </div> </a>\n   </div>\n   <div class=\"section-container-group\">\n    <div class=\"section\" ng-repeat=\"section in data.sections\"><img ng-src=\"{{ section.image }}\" alt=\"{{ section.title }} Icon\">\n     <div class=\"section-info\"><span class=\"section-title\"> {{ section.title }} Synthetic rule 48 </span> <span class=\"section-description\"> {{ section.description }} </span>\n     </div>\n    </div>\n   </div>\n  </div>\n  <div class=\"col-md-3 col-sm-4 col-xs-12 notmobile\" ng-if=\"data.image_location == 'right'\"><sp-widget widget=\"c.data.image_widget\"></sp-widget>\n  </div>\n </div>\n</div>",
                                    "client_script": "api.controller=function() {\n  var c = this;\n};\n",
                                    "data": {
                                      "image_fit": "Synthetic value",
                                      "buttons": [
                                        {
                                          "active": false,
                                          "href": "/smart/en?id=synthetic_0",
                                          "title": "Synthetic button 0"
                                        },
                                        {
                                          "active": false,
                                          "href": "/smart/en?id=synthetic_1",
                                          "title": "Synthetic button 1"
                                        },
                                        {
                                          "active": false,
                                          "href": "/smart/en?id=synthetic_2",
                                          "title": "Synthetic button 2"
                                        }
                                      ],
                                      "image_attachment_filename": "Synthetic value",
                                      "image_alt": "Synthetic value",
                                      "description": "<p>Synthetic requirement paragraph.</p><p>Whole second requirement.</p>",
                                      "image_attachment": "Synthetic value",
                                      "image_title": "",
                                      "title": "Synthetic programme heading",
                                      "image_src": "Synthetic value",
                                      "image_widget": {
                                        "sys_id": "dda3e7808762fe105831a7530cbb3596",
                                        "public": true,
                                        "roles": "",
                                        "async_load": false,
                                        "options": {
                                          "async_load": false
                                        },
                                        "template": "<div class=\"section-image\"><a href=\"{{data.image_attachment}}\" target=\"_blank\" ng-if=\"data.image_attachment != ''\" ng-class=\"{'image-fit': c.data.image_fit == 'fit'}\" ng-click=\"googleTagMgr(c.data.image_attachment_filename)\"> <img src=\"{{data.image_src}}\" alt=\"{{data.image_alt}}\">\n  <div class=\"image-title\" ng-if=\"data.image_title != ''\"> {{c.data.image_title}} </div>\n  <div class=\"overlay overlayeffect\" ng-if=\"data.image_overlay == true\"><i class=\"fa fa-external-link fa-4x\" aria-hidden=\"true\" width=\"100\" height=\"50\" style=\"filter: brightness(0) invert(1);\"></i>\n  </div> </a> <span ng-if=\"data.image_attachment == ''\" ng-class=\"{'image-fit': c.data.image_fit == 'fit'}\"> <img src=\"{{data.image_src}}\" alt=\"{{data.image_alt}}\">\n  <div class=\"image-title\" ng-if=\"data.image_title != ''\"> {{c.data.image_title}} </div>\n  <div class=\"overlay overlayeffect\" ng-if=\"data.image_overlay == true\"><i class=\"fa fa-external-link fa-4x\" aria-hidden=\"true\" width=\"100\" height=\"50\" style=\"filter: brightness(0) invert(1);\"></i>\n  </div> </span>\n</div>",
                                        "client_script": "api.controller=function($scope) {\n  var c = this;\n\t\n\t$scope.googleTagMgr = function(fileName) {\n\t\tvar extension = fileName.split('.').pop();\n\t\tswitch (extension){\n\t\t\tcase 'pdf':\n\t\t\t\tdataLayer.push({\n\t\t\t\t\t'event': 'pdf_download_servicenow',\n'pdfFileName': fileName,\n'downloadPage': window.location\n\t\t\t\t});\n\t\t\t\tbreak;\n\t\t\tdefault:\t\t\t\t\n\t\t\t\tdataLayer.push({\n\t\t\t\t\t'event': 'image_download_servicenow',\n'imgFileName': fileName,\n'downloadPage': window.location\n\t\t\t\t});\n\t\t\t\tbreak;\n\t\t}\t\t\n\t};\n\t\n};\n",
                                        "data": {
                                          "image_fit": "Synthetic value",
                                          "image_overlay": "false",
                                          "image_attachment_filename": "Synthetic value",
                                          "image_alt": "Synthetic value",
                                          "image_attachment": "Synthetic value",
                                          "image_title": "",
                                          "image_src": "Synthetic value"
                                        },
                                        "link": "function link(scope, element, attrs, controller) { \n\n }"
                                      },
                                      "image_overlay": "false",
                                      "background": "Synthetic value",
                                      "image_location": "left"
                                    },
                                    "link": "function link(scope, element, attrs, controller) { \n\n }"
                                  },
                                  "showApply": true,
                                  "universities": 100,
                                  "selectionLink": "/synthetic-selection",
                                  "showClosedWarning": false,
                                  "pyOpenNextYear": "Synthetic value",
                                  "showPanelistRegButton": false,
                                  "scholars": 100,
                                  "facilities": 100,
                                  "smart_carousel": {
                                    "sys_id": "cf3766131ba875107695a82fe54bcb0f",
                                    "public": true,
                                    "roles": "",
                                    "async_load": false,
                                    "options": {
                                      "async_load": false
                                    },
                                    "template": "<div class=\"carousel-container\" ng-if=\"data.carousels.length != 0\">\n <div ng-repeat=\"i in data.carousels | offset:c.currentPage*data.pageSize | limitTo:data.pageSize\" class=\"carousel-item\"><a ng-disabled=\"c.currentPage == 0\" class=\"btn btn-links\" ng-click=\"c.currentPage=c.currentPage-1\"> <i class=\"fa fa-chevron-left\" aria-hidden=\"true\"></i> </a> <span ng-if=\"i.link==''\" class=\"carousel-title\"> {{i.title}} </span> <span ng-if=\"i.link!=''\" class=\"carousel-title\"><a ng-href=\"{{i.link}}\" target=\"_blank\"> {{i.title}} </a></span> <a class=\"btn btn-links\" ng-class=\"{disabled:c.currentPage==data.num_pages-1}\" ng-disabled=\"c.currentPage==data.num_pages-1\" ng-click=\"c.currentPage=c.currentPage+1\"> <i class=\"fa fa-chevron-right\"></i> </a>\n </div>\n</div>",
                                    "client_script": "api.controller=function($scope) {\n  var c = this;\n\t\n\tc.notePos = 0;\n\tc.currentPage=0;\n\t$scope.getNumber = function(num) {\n\t\treturn new Array(num);\n\t};\n\t$scope.mathMin = function(v1,v2){\n\t\treturn Math.min(v1,v2);\n\t};\n};\n",
                                    "data": {
                                      "num_pages": 0,
                                      "pageSize": 100,
                                      "portal": "smart",
                                      "carousels": [],
                                      "row_count": 0
                                    },
                                    "link": "function link(scope, element, attrs, controller) { \n\n }"
                                  }
                                },
                                "link": "function link(scope, element, attrs, controller) { \n\n }"
                              },
                              "instance_id": "e345860f1be161101c91426de54bcb0c",
                              "title": ""
                            }
                          ],
                          "class_name": "",
                          "semantic_tag": "",
                          "order": 1
                        }
                      ],
                      "class_name": "",
                      "semantic_tag": "",
                      "order": 1
                    }
                  ],
                  "widgets": [],
                  "class_name": "",
                  "semantic_tag": "",
                  "order": 1
                }
              ],
              "class_name": "",
              "semantic_tag": "",
              "order": 1
            }
          ],
          "class_name": "",
          "semantic_tag": "",
          "order": 1
        }
      ],
      "page": {
        "id": "smart_index",
        "sys_id": "2a47254fdb350300ecc734cc7c961992",
        "public": true,
        "draft": false,
        "internal": false,
        "title": "Synthetic award programme",
        "u_portal": "f2a05466db71c300b67330ca7c9619f0"
      },
      "user": {
        "logged_in": false,
        "can_debug": false,
        "can_debug_admin": false
      },
      "announcements": [],
      "seotags": []
    }
  },
  "eligibility": {
    "result": {
      "$$uiNotification": [],
      "metatags": [],
      "theme": {
        "header": {
          "sys_id": "69505de91bce90107695a82fe54bcbc1",
          "public": true,
          "roles": "",
          "async_load": false,
          "options": {
            "async_load": false
          },
          "template": "<noscript> Synthetic rule 49 </noscript>\n<img style=\"display:none\" src=\"https://data.adxcel-ec2.com/pixel/?ad_log=referer&amp;action=lead&amp;pixid=18d72af0-9a7a-4735-9776-7dd2a91bcbd0\" width=\"1\" height=\"1\" border=\"0\">\n<noscript> Synthetic rule 50 </noscript>\n<script></script>\n<script></script>\n<script type=\"application/ld+json\"></script>\n<div class=\"announcement\"><sp-widget widget=\"c.data.announcementWidget\"></sp-widget>\n</div>\n<div class=\"menusFixed\">\n <div class=\"toggle\">\n  <div class=\"row togglerow\">\n   <div class=\"col-md-12 right\"><button class=\"navbar-toggler p-5 border-0\" type=\"button\" data-toggle=\"collapse\" data-target=\".navbar-collapse\"> <i class=\"fa fa-bars fa-2x\" aria-hidden=\"true\"></i> </button>\n   </div>\n  </div>\n  <div class=\"navbar-collapse collapse nopadding\" aria-expanded=\"false\">\n   <div class=\"nav-container\"><sp-widget widget=\"data.menu\"></sp-widget>\n    <ul class=\"nav navbar-nav\">\n     <li><a href=\"https://mailchi.mp/e696f3ce2730/smart\" target=\"_blank\"> Synthetic rule 51 </a></li>\n     <li ng-if=\"!user.logged_in &amp;&amp; page.id != portal.login_page_dv &amp;&amp; !data.hasLogin\"><a href=\"\" ng-click=\"LoginRedirect()\"> Synthetic rule 52 </a></li>\n     <li ng-if=\"user.logged_in\" class=\"dropdown hidden-sm\"><a href=\"javascript:void(0)\" class=\"dropdown-toggle\" data-toggle=\"dropdown\" aria-expanded=\"false\" title=\"{{data.profileBtnMsg}}\" id=\"profile-dropdown\"> <span class=\"navbar-avatar\">\n        <sn-avatar class=\"avatar-small-medium\" primary=\"userID\"></sn-avatar></span> <span class=\"visible-lg-inline\"> {{::user.name}} </span>\n       <sp-widget widget=\"c.data.announcementPicker\"></sp-widget> </a>\n      <ul class=\"dropdown-menu\" role=\"menu\">\n       <li><a ng-href=\"?id=user_profile&amp;sys_id={{::user.sys_id}}\" role=\"menuitem\"> Synthetic rule 53 </a></li>\n       <li ng-if=\"::!isViewNative\"><a href=\"{{::portal.logoutUrl}}\" role=\"menuitem\"> Synthetic rule 54 </a></li>\n      </ul></li>\n     <li ng-if=\"user.logged_in\" class=\"visible-xs-block\"><a ng-href=\"?id=user_profile&amp;sys_id={{::user.sys_id}}\"> {{::user.name}} </a></li>\n     <li ng-if=\"::!isViewNative &amp;&amp; user.logged_in\" class=\"visible-xs-block\"><a href=\"{{::portal.logoutUrl}}\"> Synthetic rule 55 </a></li>\n    </ul>\n   </div>\n  </div>\n </div>\n <div class=\"row navtop notmobile\">\n  <div class=\"col-lg-8\">\n  </div>\n  <div class=\"col-lg-4\">\n   <div class=\"navbar-right login-container\" align=\"center\">\n    <ul ng-if=\"(!user.logged_in &amp;&amp; page.id != portal.login_page_dv &amp;&amp; !data.hasLogin)\" class=\"navbar-nav\">\n     <li><a href=\"\" ng-click=\"LoginRedirect()\"> Synthetic rule 56 </a></li>\n    </ul>\n    <ul ng-if=\"::user.logged_in\" aria-haspopup=\"true\" data-toggle=\"dropdown\">\n     <li class=\"dropdown hidden-xs\"><a href=\"javascript:void(0)\" class=\"dropdown-toggle\" data-toggle=\"dropdown\" aria-expanded=\"false\" title=\"{{data.profileBtnMsg}}\" id=\"profile-dropdown\"> <span class=\"navbar-avatar\">\n        <sn-avatar class=\"avatar-small-medium\" primary=\"userID\"></sn-avatar></span> <span class=\"visible-lg-inline visible-md-inline visible-sm-inline\"> {{::user.name}} </span>\n       <sp-widget widget=\"c.data.announcementPicker\"></sp-widget> </a>\n      <ul class=\"dropdown-menu\" role=\"menu\">\n       <li><a ng-href=\"?id=user_profile&amp;sys_id={{::user.sys_id}}\" role=\"menuitem\"> Synthetic rule 57 </a></li>\n       <li ng-if=\"::!isViewNative\"><a href=\"{{::portal.logoutUrl}}\" role=\"menuitem\"> Synthetic rule 58 </a></li>\n      </ul></li>\n     <li class=\"visible-xs-block\"><a ng-href=\"?id=user_profile&amp;sys_id={{::user.sys_id}}\"><span class=\"navbar-avatar\">\n        <sn-avatar class=\"avatar-small-medium\" primary=\"userID\"></sn-avatar></span> {{::user.name}} </a></li>\n     <li ng-if=\"::!isViewNative\" class=\"visible-xs-block\"><a href=\"{{::portal.logoutUrl}}\"> Synthetic rule 59 </a></li>\n    </ul>\n   </div>\n   <div class=\"navbar-right subscribe-container\">\n    <ul class=\"nav navbar-nav\">\n     <li><a href=\"https://mailchi.mp/e696f3ce2730/smart\" target=\"_blank\"> Synthetic rule 60 </a></li>\n    </ul>\n   </div>\n  </div>\n </div>\n <div class=\"row navmiddle\">\n  <div class=\"col-md-6 col-sm-7 main-container\"><span class=\"logos\"> <img src=\"../DOW-Seal.png\" alt=\"The DoW Logo\" class=\"imgWidth\" role=\"presentation\"> </span> <span class=\"navtitle\">\n    <div class=\"navdod\"> Synthetic rule 61 </div>\n    <div> Synthetic rule 62 </div> </span>\n  </div>\n  <div class=\"col-md-6 col-sm-5 main-container no-mobile\">\n   <div class=\"app-info\" ng-if=\"data.showClosedWarning\"><span class=\"titleClosedWarning\"> Synthetic rule 63 <span class=\"closedWarningText\"> {{data.pyOpenNextYear}} </span> </span>\n   </div>\n   <div class=\"app-clock\" ng-if=\"!data.showClosedWarning\">\n    <div ng-if=\"data.showApply\"><sp-widget ng-if=\"data.wCountdown\" widget=\"data.wCountdown\"></sp-widget>\n    </div>\n   </div>\n  </div>\n </div>\n <div class=\"row navbottom\">\n  <div class=\"col-md-11\">\n   <div class=\"nav-container mainnav\">\n    <nav role=\"navigation\"><sp-widget widget=\"data.menu\"></sp-widget>\n    </nav>\n   </div>\n  </div>\n </div>\n</div>",
          "client_script": "function ($rootScope, $window, $scope, snRecordWatcher, spUtil, spModal, $location, $uibModal, cabrillo, $timeout, glideSystemProperties) {\n\tvar c = this;\n\t$('#navigation #navMenu li a').click(function() {\n\t\talert($(this).text());\n\t\t$('.offcanvas-collapse').toggleClass('open');\n\t});\n\t\n\t$scope.userID = $scope.user.sys_id;\n\tif (cabrillo.isNative())\n\t\t$scope.isViewNative = true;\t\n\t\t\n\t$scope.openPopUp = function() {\n\t\tvar url = \"$chat_support.do?queueID=\" + $scope.data.connect_support_queue_id;\n\t\tvar popup = window.open (url, \"popup\", \"width=900, height=600\");\n\t};\n\t$scope.openLogin = function () {\n\t\t$scope.modalInstance = $uibModal.open({\n\t\t\ttemplateUrl: 'modalLogin',\n\t\t\tscope: $scope\n\t\t});\n\t};\n\t$rootScope.$on('sp.avatar_changed', function() {\n\t\t$scope.userID = \"\";\n\t\t$timeout(function(){\n\t\t\t$scope.userID = $scope.user.sys_id;\n\t\t});\n\t});\n\t$scope.isHomepage = function() {\n\t\tif (!$scope.page.id)\n\t\t\treturn true;\n\t\tif ($scope.page.id == $scope.portal.homepage_dv)\n\t\t\treturn true;\n\t\treturn false;\n\t};\n\tvar shared={};\n\t$scope.mailListSubscribe = function(widgetId, widgetInput) {\n\t\tspModal.open({\n\t\t\ttitle: 'SMART Subscription Form',\n\t\t\twidget: widgetId,\n\t\t\twidgetInput: widgetInput || {},\n\t\t\tbuttons: [{label: 'Close', primary: true}],\n\t\t\tshared: shared\n\t\t}).then(function(){\n\t\t})\n\t\t\n\t};\n\t\n\t$scope.LoginRedirect = function() {\n$window.location = 'https://'+ $window.location.hostname +\"/smart?id=login\";\n\t};\n}\n",
          "data": {
            "announcementPicker": {},
            "menu": {
              "sys_id": "5ef595c1cb12020000f8d856634c9c6e",
              "public": true,
              "roles": "",
              "async_load": false,
              "options": {
                "async_load": false
              },
              "template": "<p>Excluded synthetic UI.</p>",
              "client_script": "",
              "data": {
                "replace": true,
                "isLoggedIn": false,
                "showWishlist": false,
                "guidedTours": null,
                "menu": {},
                "showTours": false
              }
            },
            "typeahead": {},
            "showApply": true,
            "wCountdown": {
              "sys_id": "5947caa91bfc94107695a82fe54bcb5f",
              "public": true,
              "roles": "",
              "async_load": false,
              "options": {
                "async_load": false
              },
              "template": "<div ng-show=\"data.showCountDown\"><sp-widget widget=\"data.countDownWidget\"></sp-widget>\n</div>",
              "client_script": "function($scope, spUtil) {\n\tvar c = this;\n\t\n\tspUtil.recordWatch($scope, \"x_smart_program_year\", \"active=false\", function(name) {\n\t\t\t\n\t\tc.server.refresh();\n\t});\n\t\n}\n",
              "data": {
                "showCountDown": true,
                "countDownWidget": {
                  "sys_id": "281b37e04f6e13004b5c30318110c74d",
                  "public": true,
                  "roles": "",
                  "async_load": false,
                  "options": {
                    "async_load": false
                  },
                  "template": "<div><span class=\"apptitle\" id=\"apptitle\"> Synthetic rule 64 {{data.status}} Synthetic rule 65 </span> <span id=\"clockdiv\">\n  <div>\n   <div class=\"smalltext\"> Synthetic rule 66 </div><span class=\"days\"></span>\n  </div>\n  <div>\n   <div class=\"smalltext\"> Synthetic rule 67 </div><span class=\"hours\"></span>\n  </div>\n  <div>\n   <div class=\"smalltext\"> Synthetic rule 68 </div><span class=\"minutes\"></span>\n  </div>\n  <div class=\"hidden\">\n   <div class=\"smalltext\"> Synthetic rule 69 </div><span class=\"seconds\"></span>\n  </div> </span>\n</div>",
                  "client_script": "function($scope, spUtil) {\n\tvar c = this;\n\tfunction getTimeRemaining(endtime) {\n  var t = Date.parse(endtime) - Date.parse(new Date());\nvar seconds = Math.floor((t / 1000) % 60);\nvar minutes = Math.floor((t / 1000 / 60) % 60);\nvar hours = Math.floor((t / (1000 * 60 * 60)) % 24);\nvar days = Math.floor(t / (1000 * 60 * 60 * 24));\n  return {\n    'total': t,\n    'days': days,\n    'hours': hours,\n    'minutes': minutes,\n    'seconds': seconds\n  };\n}\nfunction initializeClock(id, endtime) {\n  var clock = document.getElementById(id);\n\tvar app = document.getElementById('apptitle');\n  var daysSpan = clock.querySelector('.days');\n  var hoursSpan = clock.querySelector('.hours');\n  var minutesSpan = clock.querySelector('.minutes');\n  var secondsSpan = clock.querySelector('.seconds');\n  function updateClock() {\n    var t = getTimeRemaining(endtime);\n\t\tif (t.days.toString().length == 1){\n\t\t\tdaysSpan.innerHTML = ('0' + t.days).slice(-2);\n\t\t}\n\t\telse{\n\t\t\tdaysSpan.innerHTML = t.days;\n\t\t}\n    hoursSpan.innerHTML = ('0' + t.hours).slice(-2);\n    minutesSpan.innerHTML = ('0' + t.minutes).slice(-2);\n    secondsSpan.innerHTML = ('0' + t.seconds).slice(-2);\t\t\n\t\t\n    if (t.total <= 0) {\n\t\t\tclock.style.display = \"none\";\n\t\t\tapp.style.display = \"none\";\n      clearInterval(timeinterval);\n    }\n  }\n  updateClock();\n  var timeinterval = setInterval(updateClock, 1000);\n}\nvar deadline = new Date($scope.data.deadLine);\ninitializeClock('clockdiv', deadline);\n\t\n\t\n\t\n\t\n}\n",
                  "data": {
                    "visible": true,
                    "deadLine": 2000000000000,
                    "status": "Closes"
                  }
                }
              },
              "link": "function link(scope, element, attrs, controller) { \n\n }"
            },
            "connect_support_queue_id": "Synthetic value",
            "login_page": "Synthetic value",
            "showClosedWarning": false,
            "profileBtnMsg": "Synthetic value",
            "pyOpenNextYear": "Synthetic value",
            "hasLogin": false,
            "announcementWidget": {
              "sys_id": "1e6a42edd442b2007f44c8341d4d3b57",
              "public": true,
              "roles": "",
              "async_load": false,
              "options": {
                "async_load": false
              },
              "template": "<p>Excluded synthetic UI.</p>",
              "client_script": "",
              "data": {
                "showAnnouncements": true,
                "outages": [],
                "informationAnnouncementIDs": "Synthetic value",
                "informationAnnouncements": [],
                "outageIDs": "Synthetic value"
              }
            },
            "loginWidget": {
              "sys_id": "6506d341cb33020000f8d856634c9cdc",
              "public": true,
              "roles": "",
              "async_load": false,
              "options": {
                "async_load": false
              },
              "template": "<p>Excluded synthetic UI.</p>",
              "client_script": "",
              "data": {
                "usernameMsg": "Synthetic value",
                "certAuthRedirect": false,
                "isMultiSSOActive": false,
                "pageURI": "/smart/en?id=smart_eligibility",
                "forgetMe": true,
                "rememberMeDefault": false,
                "passwordMsg": "Synthetic value",
                "multisso_enabled": false,
                "default_idp": null,
                "errorMsg": "Synthetic value",
                "isShowLoginWithIdps": false,
                "is_logged_in": false,
                "errorMsg2": "Synthetic value",
                "pswdResetUrl": "Synthetic value",
                "forgotPwdLinkProp": "Synthetic value",
                "multiFactorAuthEnabled": true,
                "ssoSelectorFieldLabel": "Synthetic value"
              }
            }
          },
          "link": "function(scope, element) {\n\t$('[data-toggle=\"offcanvas\"]').on('click', function () {\n    $('.offcanvas-collapse').toggleClass('open');\n  });\n\t\n\t$(document).keyup(function(event) {\n\t\tif (event.which == 9) { //tab key handler + arrow keys\n\t\t\tif ($(event.target).parents(\".dropdown-menu\").length == 0) { //if we are NOT inside a dropdown...\n\t\t\t\t//close the dropdowns\n\t\t\t\t$(\".dropdown\").removeClass(\"open\");\n\t\t\t\t$(\"[data-toggle='dropdown']\").attr(\"aria-expanded\", \"false\");\n\t\t\t}\n\t\t}\n\t});\n\t\n\t$(element).on('click.nav','.navbar-collapse.in',function(e) {\n\t\tvar target = $(e.target);\n\t\tif (target.is('a')) {\n\t\t\tif (target.hasClass('sp-menu-has-items'))\n\t\t\t\treturn; // menu item has a submenu, so just toggle it\n\t\t\t\n\t\t\t// collapse mobile nav if clicked an anchor\n\t\t\t$(this).removeClass('in').addClass('collapse');\n\t\t\tconsole.log('link function');\n\t\t\treturn;\n\t\t}\n\n\t\tif (target.parent().hasClass(\"toggle-dropdown\")) {\n\t\t\t// collapse mobile nav if parent has toggle-dropdown class\n\t\t\t$(this).removeClass('in').addClass('collapse');\n\t\t\tconsole.log('link function');\n\t\t\treturn;\n\t\t}\n\n\t\t// if neither target nor parent is an anchor, do nothing\n\t\tif (!target.parent().is('a'))\n\t\t\treturn;\n\n\t\t// collapse mobile nav if target is part of a submenu\n\t\tif (target.parents(\"ul.dropdown-menu\").length > 0){\n\t\t\t$(this).removeClass('in').addClass('collapse');\n\t\t\tconsole.log('link function');\n\t\t}\n\t});\n}"
        },
        "footer": {
          "sys_id": "f908e94fdb350300ecc734cc7c9619b2",
          "public": true,
          "roles": "",
          "async_load": false,
          "options": {
            "async_load": false
          },
          "template": "<p>Excluded synthetic UI.</p>",
          "client_script": "",
          "data": {
            "showLinks": true,
            "portal": "smart"
          }
        }
      },
      "containers": [
        {
          "sys_id": "044c184a872a86105831a7530cbb3519",
          "bootstrap_alt": false,
          "subheader": false,
          "background": "{\"background-size\":\"initial\",\"background-position\":\"center center\"}",
          "width": "container-fluid",
          "container_class_name": "",
          "title": "",
          "rows": [
            {
              "sys_id": "160d148a872a86105831a7530cbb35bd",
              "columns": [
                {
                  "sys_id": "160d148a872a86105831a7530cbb35c1",
                  "size_classes": "col-md-12 ",
                  "rows": [],
                  "widgets": [
                    {
                      "sys_id": "284e7f87876a4e105831a7530cbb350f",
                      "widget": {
                        "sys_id": "6914f1b61b8a5c107695a82fe54bcbb9",
                        "public": true,
                        "roles": "",
                        "async_load": false,
                        "options": {
                          "async_load": false
                        },
                        "template": "<p>Excluded synthetic UI.</p>",
                        "client_script": "",
                        "data": {
                          "visible": true,
                          "technical_help_widget": {
                            "sys_id": "06cb6e981b9fc1507695a82fe54bcb40",
                            "public": true,
                            "roles": "",
                            "async_load": false,
                            "options": {
                              "async_load": false
                            },
                            "template": "<p>Excluded synthetic UI.</p>",
                            "client_script": "",
                            "data": {
                              "error_message_problem_desc": "Synthetic value",
                              "parent_email_valid": false,
                              "error_message_email": "Synthetic value",
                              "show_tech_help_request_modal": true,
                              "text_input_3_valid": false,
                              "all_inputs_valid": false,
                              "is_newselection": false,
                              "u_parent_email": "Synthetic value",
                              "text_input_2_valid": false,
                              "is_popup": false,
                              "portal_id": "Synthetic value",
                              "form_input": {},
                              "portal": "smart",
                              "portal_input_valid": true,
                              "email": "Synthetic value",
                              "problem_description": "Synthetic value",
                              "submit_message": "Synthetic value",
                              "text_input_4_valid": false,
                              "priority_choices": [],
                              "priority_input_valid": false,
                              "show_issuetype_choices": false,
                              "is_selection": false,
                              "showcross": true,
                              "issue_type": "Synthetic value",
                              "issuetype_input_valid": false,
                              "u_currently_minor": "Synthetic value",
                              "priority": "Synthetic value",
                              "text_input_1_valid": false,
                              "submitted": false,
                              "show_portal_choices": false,
                              "problem_last_name": "Synthetic value",
                              "issue_type_choices": [],
                              "portal_choices": [],
                              "show_priority_choices": false,
                              "problem_first_name": "Synthetic value"
                            }
                          },
                          "background": "Synthetic value",
                          "page": "smart_eligibility",
                          "title": "Synthetic programme heading",
                          "inAwardee": false,
                          "show_technical_help_request_popup": false,
                          "buttonHide": true,
                          "email": "Synthetic value"
                        }
                      },
                      "instance_id": "284e7f87876a4e105831a7530cbb350f",
                      "title": "SMART Scholarship Eligibility and Program Requirements"
                    },
                    {
                      "sys_id": "b51d508a872a86105831a7530cbb353f",
                      "widget": {
                        "sys_id": "437c908a872a86105831a7530cbb3508",
                        "public": true,
                        "roles": "",
                        "async_load": false,
                        "options": {
                          "async_load": false
                        },
                        "template": "<div>\n <div class=\"info-container padder-v-xl padder-b-n\">\n  <div class=\"row padder-xl\">\n   <div class=\"col-md-12\">\n    <div class=\"col-md-3 col-sm-3 col-xs-12 m-t-sm font-black\">\n     <div class=\"panel panel-default\">\n      <div class=\"panel-heading no-padder\">\n       <h3 class=\"panel-title\"><img src=\"x_smart.eligibility_header.png\" width=\"100%\" height=\"100%\" alt=\"Photo of four college students gathered around a computer screen.\" title=\"Photo of four college students gathered around a computer screen.\"></h3>\n      </div>\n      <div class=\"info-panel panel-body bold\">\n       <p> Synthetic rule 70 </p>\n      </div>\n     </div>\n    </div>\n    <div class=\"col-md-9 col-sm-9 col-xs-12\">\n     <div class=\"row col-md-12\">\n      <h2 class=\"h4 font-black no-padder m-n\"><span class=\"padder-b-xs smart-underline font-bold\"> Synthetic rule 71 </span></h2>\n     </div>\n     <div class=\"row col-md-12 m-t-lg font-black\">\n      <p> Synthetic rule 72 <br> <br> Synthetic rule 73 </p>\n      <ul>\n       <li ng-repeat=\"d in c.data.loDiscipline\"> {{d.name}} </li>\n      </ul>\n      <div>\n       <p><i> Synthetic rule 74 </i></p>\n      </div>\n     </div>\n     <div class=\"row col-md-12 col-md-offset-0 col-xs-11 padder-v-lg button-row col-xs-offset-1\"><a class=\"button-container padder m-l-xs m-r-xs m-b\" href=\"/smart/en?id=kb_article&amp;sys_id=97b9e7cb470403d027859d4c326d4316\"> Synthetic rule 75 </a> <a class=\"button-container padder m-r-xs m-b\" href=\"/smart/en?id=smart_opportunities\"> Synthetic rule 76 </a> <a class=\"button-container padder m-l-xs m-r-xs m-b\" href=\"/smart/en?id=kb_article&amp;sys_id=0383c5d6db2a03006bb8f4b40f961956\"> Synthetic rule 77 </a> <a class=\"button-container padder m-l-xs m-r-xs m-b\" href=\"javascript:void(0)\" ng-click=\"showContactUsModal()\"> Synthetic rule 78 </a> <a ng-if=\"data.showApplyButton\" class=\"button-container-active padder m-l-xs m-r-xs m-b\" href=\"/smart/en?id=application_registration\"> Synthetic rule 79 </a>\n     </div>\n    </div>\n   </div>\n  </div>\n </div>\n <div class=\"eligibility-widget\">\n  <div class=\"row padder\">\n   <div class=\"col-md-12\"><sp-widget widget=\"c.data.eligibility_info\">\n   </sp-widget></div>\n  </div>\n </div>\n <div class=\"faq-container padder-v-xl\">\n  <div class=\"row padder-xl\">\n   <div class=\"col-md-1 col-xs-12\"></div>\n   <div class=\"col-md-10 col-xs-12\">\n    <div class=\"row\">\n     <div class=\"col-md-12\">\n      <h2 class=\"text-center h4 font-black no-padder m-n\"><span class=\"padder-b-xs smart-underline font-bold\"> Synthetic rule 80 </span></h2>\n     </div>\n    </div>\n    <div class=\"row col-md-12 m-t-lg font-black\">\n     <p class=\"text-center\"> Synthetic rule 81 </p>\n    </div>\n    <div class=\"row col-md-12\">\n     <div class=\"accordion\" id=\"faqAccordion\">\n      <div class=\"card b-b padder-v-xs\">\n       <div class=\"card-header\" id=\"headingOne\">\n        <h2 class=\"mb-0\"><button class=\"btn faq-button text-left accordion-button\" type=\"button\" data-toggle=\"collapse\" data-target=\"#collapseOne\" aria-expanded=\"false\" aria-controls=\"collapseOne\">\n          <div class=\"flex-row justify-between items-center\">\n           <div class=\" text-xs\">\n            <p class=\"m-n\" style=\"text-wrap:auto\"> Synthetic rule 82 </p>\n           </div>\n           <div class=\"text-right col-md-6\"><i class=\"fa fa-solid fa-chevron-down chevron\"></i>\n           </div>\n          </div> </button></h2>\n       </div>\n       <div id=\"collapseOne\" class=\"collapse\" aria-labelledby=\"headingOne\" data-parent=\"#faqAccordion\">\n        <div class=\"card-body\">\n         <p> Synthetic rule 83 </p>\n        </div>\n       </div>\n      </div>\n     </div>\n     <div class=\"accordion\" id=\"faqAccordion\">\n      <div class=\"card b-b padder-v-xs\">\n       <div class=\"card-header\" id=\"headingTwo\">\n        <h2 class=\"mb-0 mt-0\"><button class=\"btn faq-button text-left accordion-button\" type=\"button\" data-toggle=\"collapse\" data-target=\"#collapseTwo\" aria-expanded=\"false\" aria-controls=\"collapseTwo\">\n          <div class=\"flex-row justify-between items-center\">\n           <div class=\" text-xs\">\n            <p class=\"m-n\" style=\"text-wrap:auto\"> Synthetic rule 84 </p>\n           </div>\n           <div class=\"text-right col-md-6\"><i class=\"fa fa-solid fa-chevron-down chevron\"></i>\n           </div>\n          </div> </button></h2>\n       </div>\n       <div id=\"collapseTwo\" class=\"collapse\" aria-labelledby=\"headingTwo\" data-parent=\"#faqAccordion\">\n        <div class=\"card-body\">\n         <p> Synthetic rule 85 {{data.pyYearOnlyPlusOne}} Synthetic rule 86 </p>\n        </div>\n       </div>\n      </div>\n     </div>\n     <div class=\"accordion\" id=\"faqAccordion\">\n      <div class=\"card b-b padder-v-xs\">\n       <div class=\"card-header\" id=\"headingThree\">\n        <h2 class=\"mb-0\"><button class=\"btn faq-button text-left accordion-button\" type=\"button\" data-toggle=\"collapse\" data-target=\"#collapseThree\" aria-expanded=\"false\" aria-controls=\"collapseThree\">\n          <div class=\"flex-row justify-between items-center\">\n           <div class=\"text-xs\">\n            <p class=\"m-n\" style=\"text-wrap:auto\"> Synthetic rule 87 </p>\n           </div>\n           <div class=\"text-right col-md-6\"><i class=\"fa fa-solid fa-chevron-down chevron\"></i>\n           </div>\n          </div> </button></h2>\n       </div>\n       <div id=\"collapseThree\" class=\"collapse\" aria-labelledby=\"headingThree\" data-parent=\"#faqAccordion\">\n        <div class=\"card-body\">\n         <p> Synthetic rule 88 {{data.pyYearOnlyPlusOne}} Synthetic rule 89 </p>\n        </div>\n       </div>\n      </div>\n     </div> <!--<div class=\"accordion\" id=\"faqAccordion\">\n            <div class=\"card b-b padder-v-xs\">\n              <div class=\"card-header\" id=\"headingFour\">\n                <h2 class=\"mb-0\">\n                  <button class=\"btn faq-button text-left accordion-button\" type=\"button\" data-toggle=\"collapse\" data-target=\"#collapseFour\" aria-expanded=\"false\" aria-controls=\"collapseFour\">\n                    <div class=\"flex-row justify-between items-center\">\n                      <div class=\"text-xs\">\n                        <p class=\"m-n\"  style=\"text-wrap:auto\">How do I know which scholarship I should apply for?</p>\n                      </div>\n                      <div class=\"text-right col-md-6\">\n                        <i class=\"fa fa-solid fa-chevron-down chevron\"></i>\n                      </div>\n                    </div>\n                  </button>\n                </h2>\n              </div>\n              <div id=\"collapseFour\" class=\"collapse\" aria-labelledby=\"headingFour\" data-parent=\"#faqAccordion\">\n                <div class=\"card-body\">\n                  <p>\n                    The system will ask eligibility questions at the start of an application and inform applicants which scholarship they are eligible for. Applicants who can produce a college transcript are not eligible for the Dellums SMART Scholarship and should consider applying to the SMART Scholarship Program. AP credit is not considered a college transcript.\n                  </p>\n                </div>\n              </div>\n            </div>\n          </div>-->\n     <div class=\"accordion\" id=\"faqAccordion\">\n      <div class=\"card b-b padder-v-xs\">\n       <div class=\"card-header\" id=\"headingFive\">\n        <h2 class=\"mb-0\"><button class=\"btn faq-button text-left accordion-button\" type=\"button\" data-toggle=\"collapse\" data-target=\"#collapseFive\" aria-expanded=\"false\" aria-controls=\"collapseFive\">\n          <div class=\"flex-row justify-between items-center\">\n           <div class=\"text-xs\">\n            <p class=\"m-n\" style=\"text-wrap:auto\"> Synthetic rule 90 </p>\n           </div>\n           <div class=\"text-right col-md-6\"><i class=\"fa fa-solid fa-chevron-down chevron\"></i>\n           </div>\n          </div> </button></h2>\n       </div>\n       <div id=\"collapseFive\" class=\"collapse\" aria-labelledby=\"headingFive\" data-parent=\"#faqAccordion\">\n        <div class=\"card-body\">\n         <p> Synthetic rule 91 </p>\n        </div>\n       </div>\n      </div>\n     </div>\n    </div>\n    <div class=\"row col-md-12 col-md-offset-0 text-center col-xs-6 padder-v-lg button-row col-xs-offset-3\"><a class=\"button-container padder m-r-xs m-b\" href=\"/smart/en?id=kb_article&amp;sys_id=30d91073dbb54300b67330ca7c96197c\"> Synthetic rule 92 </a> <a class=\"button-container padder m-l-xs m-r-xs m-b\" href=\"/smart/en?id=kb_article&amp;sys_id=84f05b02db5ac3006bb8f4b40f9619cc \"> Synthetic rule 93 </a> <a class=\"button-container padder m-l-xs m-r-xs m-b\" href=\"javascript:void(0)\" ng-click=\"showContactUsModal()\"> Synthetic rule 94 </a>\n    </div>\n   </div>\n   <div class=\"col-md-1 col-xs-12\"></div>\n  </div>\n </div>\n <div class=\"row padder-v next-steps-background font-black b-b\">\n  <div class=\"padder-v-xl\" role=\"img\" aria-label=\"Background image of abstract geometry.\">\n   <div class=\"row padder-xl\">\n    <div class=\"col-md-12\">\n     <div class=\"col-lg-7 col-md-7\">\n      <div class=\"row col-md-12\">\n       <h2 class=\"h4 font-black no-padder m-n\"><span class=\"padder-b-xs smart-underline font-bold\"> Synthetic rule 95 </span></h2>\n      </div>\n      <div class=\"row col-md-12 m-t-lg font-black\">\n       <p> Synthetic rule 96 </p>\n      </div>\n      <div class=\"row col-md-12 padder-v-xl\"><a class=\"button-container text-nowrap\" href=\"/smart/en?id=sponsoring_facilities \"> Synthetic rule 97 </a>\n      </div>\n     </div>\n     <div class=\"col-lg-5 col-md-5\"><iframe class=\"padder\" width=\"100%\" max-width=\"600px\" height=\"275\" src=\"{{trustSrc(c.data.video_url)}}\" title=\"YouTube video player\" frameborder=\"0\" allow=\"accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share\" referrerpolicy=\"strict-origin-when-cross-origin\" allowfullscreen=\"\"></iframe>\n     </div>\n    </div>\n   </div>\n  </div>\n </div>\n <div class=\"scholar-container padder-t-xl padder-xl\">\n  <div class=\"row\">\n   <div class=\"col-md-12\">\n    <h2 class=\"text-center h4 font-black no-padder m-n\"><span class=\"padder-b-xs smart-underline font-bold\"> Synthetic rule 98 </span></h2>\n   </div>\n   <div class=\"col-md-12 padder-t-xl\">\n    <div class=\"row \" style=\"min-height:120px;\">\n     <div class=\"col-md-3 text-center inherit-height\" ng-repeat=\"d in c.data.scholars\">\n      <div class=\"panel panel-default inherit-height\">\n       <div class=\"scholar-image-panel panel-heading no-padder position-relative\"><img class=\"profile-image\" src=\"{{d.image}}\" width=\"100%\" height=\"100%\" alt=\"{{d.alttext}}\" title=\"{{d.alttext}}\">\n        <div class=\"overlay-text\">\n         <p class=\"name font-bold\"> {{d.name}} </p>\n         <p class=\"title\"> {{d.degree}} Synthetic rule 99 {{d.discipline}} </p>\n        </div>\n       </div>\n       <div class=\"panel-body font-black inherit-height\">\n        <div ng-bind-html=\"d.text\" class=\"modalBodyText\"></div>\n       </div>\n      </div>\n     </div>\n    </div>\n   </div>\n  </div>\n </div>\n <div class=\"row padder-v font-black b-b\">\n  <div class=\"text-center\"><a class=\"button-container\" href=\"/smart/en?id=smart_videos\"> Synthetic rule 100 </a>\n  </div>\n </div>\n</div>\n<div class=\"modal \" id=\"contact-us-modal\" role=\"dialog\">\n <div class=\"modal-dialog modal-lg\"><!-- modal content -->\n  <div class=\"modal-content\">\n   <div class=\"modal-header\">\n    <h3 class=\"text-center\"> {{data.kbName}} </h3>\n   </div>\n   <div class=\"modal-body\">\n    <div ng-bind-html=\"data.kbText\" class=\"modalBodyText\">\n    </div>\n   </div>\n  </div>\n </div>\n</div>",
                        "client_script": "api.controller=function($scope, $sce) {\n  var c = this;\n\t\n\t$scope.trustSrc = function(src) {\n\t\treturn $sce.trustAsResourceUrl(src);\n\t}\n\t\n\t$scope.showContactUsModal = function(){\n\t\t$scope.data.action = 'showModal';\n\t\t$scope.server.update().then(function(){\n\t\t\t$(\"#contact-us-modal\").modal('show');\t\n\t\t});\n\t};\n};\n",
                        "data": {
                          "video_name": "Synthetic value",
                          "video_url": "https://example.test/video",
                          "pyYearOnlyPlusOne": "2031",
                          "pyYear": "2030",
                          "eligibility_info": {
                            "sys_id": "7f5af26e87e28a105831a7530cbb35b8",
                            "public": true,
                            "roles": "",
                            "async_load": false,
                            "options": {
                              "async_load": false
                            },
                            "template": "<div class=\"padder-xl\">\n <div class=\"row\">\n  <div class=\"col-md-12\">\n   <div class=\"eligibility-container\">\n    <div class=\"row\">\n     <div class=\"col-md-2 col-sm-1 col-xs-0\">\n     </div>\n     <div class=\"col-md-8 col-sm-10 col-xs-12\">\n      <div class=\"eligibility-container-inner\">\n       <h2 class=\"h4 font-black no-padder m-n\"><span ng-if=\"!data.appClosed\" class=\"padder-b-xs font-bold\"> Synthetic rule 101 {{data.currentYear}} </span> <span ng-if=\"data.appClosed\" class=\"padder-b-xs font-bold\"> Synthetic rule 102 {{data.currentYear}} Synthetic rule 103 </span></h2>\n       <div class=\"eligibility-list padder-v-lg\">\n        <ul class=\"fa-ul\" style=\"color:black\">\n         <li> Synthetic rule 104 </li>\n         <li> Synthetic rule 105 {{c.data.currentYearPlusTwo}} </li>\n         <li> Synthetic rule 106 </li>\n         <li> Synthetic rule 107 {{c.data.currentYearPlusOne}} Synthetic rule 108 </li>\n         <li> Synthetic rule 109 </li>\n         <li> Synthetic rule 110 </li>\n         <li> Synthetic rule 111 {{c.data.currentYearPlusOne}} Synthetic rule 112 </li>\n         <li> Synthetic rule 113 </li>\n         <li> Synthetic rule 114 </li>\n        </ul>\n       </div>\n      </div>\n      <div class=\"eligibility-info\">\n       <div> Synthetic rule 115 {{c.data.currentYearPlusOne}} Synthetic rule 116 </div>\n       <div> Synthetic rule 117 </div>\n      </div>\n     </div>\n    </div>\n   </div>\n  </div>\n </div>\n</div>",
                            "client_script": "api.controller=function() {\n  var c = this;\n};\n",
                            "data": {
                              "currentYearPlusOne": 2031,
                              "pyYear": "2030",
                              "pyYearPlusOne": "Synthetic value",
                              "currentYearPlusTwo": 2032,
                              "appClosed": false,
                              "currentYear": "2030"
                            },
                            "link": "function link(scope, element, attrs, controller) { \n\n }"
                          },
                          "showApplyButton": true,
                          "scholars": [
                            {
                              "name": "StoryPerson0",
                              "degree": "StoryDegree",
                              "discipline": "StoryDiscipline",
                              "text": "<p>STORY_EXCLUDED_0</p>",
                              "image": "/synthetic.png",
                              "alttext": "StoryImage",
                              "scholar_id": "story0"
                            },
                            {
                              "name": "StoryPerson1",
                              "degree": "StoryDegree",
                              "discipline": "StoryDiscipline",
                              "text": "<p>STORY_EXCLUDED_1</p>",
                              "image": "/synthetic.png",
                              "alttext": "StoryImage",
                              "scholar_id": "story1"
                            },
                            {
                              "name": "StoryPerson2",
                              "degree": "StoryDegree",
                              "discipline": "StoryDiscipline",
                              "text": "<p>STORY_EXCLUDED_2</p>",
                              "image": "/synthetic.png",
                              "alttext": "StoryImage",
                              "scholar_id": "story2"
                            },
                            {
                              "name": "StoryPerson3",
                              "degree": "StoryDegree",
                              "discipline": "StoryDiscipline",
                              "text": "<p>STORY_EXCLUDED_3</p>",
                              "image": "/synthetic.png",
                              "alttext": "StoryImage",
                              "scholar_id": "story3"
                            }
                          ],
                          "loDiscipline": [
                            {
                              "name": "Synthetic discipline 1",
                              "value": "synthetic_0",
                              "sysID": "00000000000000000000000000000001"
                            },
                            {
                              "name": "Synthetic discipline 2",
                              "value": "synthetic_1",
                              "sysID": "00000000000000000000000000000002"
                            },
                            {
                              "name": "Synthetic discipline 3",
                              "value": "synthetic_2",
                              "sysID": "00000000000000000000000000000003"
                            }
                          ],
                          "pyYearPlusOne": "Synthetic value"
                        },
                        "link": "function link(scope, element, attrs, controller) { \n\n }"
                      },
                      "instance_id": "b51d508a872a86105831a7530cbb353f",
                      "title": ""
                    }
                  ],
                  "class_name": "",
                  "semantic_tag": "",
                  "order": 1
                }
              ],
              "class_name": "",
              "semantic_tag": "",
              "order": 1
            }
          ],
          "class_name": "",
          "semantic_tag": "",
          "order": 1
        }
      ],
      "page": {
        "id": "smart_eligibility",
        "sys_id": "a15b540a872a86105831a7530cbb355c",
        "public": true,
        "draft": false,
        "internal": false,
        "title": "Synthetic award programme"
      },
      "user": {
        "logged_in": false,
        "can_debug": false,
        "can_debug_admin": false
      },
      "announcements": [],
      "seotags": []
    }
  }
};

export function createSyntheticSmartPublisherJsonFixture(key = "home") {
  if (!Object.hasOwn(FIXTURES,key)) throw new Error("Unknown synthetic SMART profile");
  const value = structuredClone(FIXTURES[key]);
  value.result.theme.header.data.announcementWidget.data.informationAnnouncementIDs = "";
  value.result.theme.header.data.announcementWidget.data.outageIDs = "";
  return value;
}
export function syntheticSmartPublisherJsonBytes(key = "home") {
  return Buffer.from(JSON.stringify(createSyntheticSmartPublisherJsonFixture(key)));
}
